import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DumpRedisOptions } from '../src/api/types.js';
import type { IoredisConnection } from '../src/ioredis.js';
import { restoreRedisDump } from '../src/restore/restoreRedisDump.js';
import { capabilitiesFor } from '../src/version/detect.js';
import type { RedisServerCapabilities } from '../src/version/types.js';
import { fixtureCommands } from './fixture/data.js';
import { dumpToBuffer } from './helpers/dump.js';
import type { ServerTarget } from './helpers/server.js';
import {
  flushDatabase,
  openConnection,
  probeServer,
  run,
  runCli,
  selectedTargets,
} from './helpers/server.js';
import type { DatabaseSnapshot } from './helpers/snapshot.js';
import { expectSnapshotsEqual, snapshotDatabase } from './helpers/snapshot.js';

const SOURCE_DB = 1;
const TARGET_DB = 2;

interface Path {
  readonly name: string;
  readonly dump: DumpRedisOptions;
  readonly restoreWith: 'library' | 'redis-cli';
}

const PATHS: readonly Path[] = [
  { name: 'text → restoreRedisDump', dump: { format: 'text' }, restoreWith: 'library' },
  { name: 'resp → restoreRedisDump', dump: { format: 'resp' }, restoreWith: 'library' },
  { name: 'text → redis-cli < dump', dump: { format: 'text' }, restoreWith: 'redis-cli' },
  { name: 'resp → redis-cli --pipe < dump', dump: { format: 'resp' }, restoreWith: 'redis-cli' },
  {
    name: 'text, payload strategy → restoreRedisDump',
    dump: { format: 'text', strategy: 'payload' },
    restoreWith: 'library',
  },
  {
    name: 'resp, payload strategy → redis-cli --pipe < dump',
    dump: { format: 'resp', strategy: 'payload' },
    restoreWith: 'redis-cli',
  },
  {
    name: 'text, tiny batches → restoreRedisDump',
    dump: { format: 'text', batchSize: 3, maxCommandBytes: 1000, scanCount: 7 },
    restoreWith: 'library',
  },
  {
    name: 'resp, relative expiration → restoreRedisDump',
    dump: { format: 'resp', expiration: 'relative' },
    restoreWith: 'library',
  },
];

for (const target of selectedTargets()) {
  describe(`round trip on ${target.label}`, () => {
    let available = false;
    let source: IoredisConnection;
    let capabilities: RedisServerCapabilities;
    let expected: DatabaseSnapshot;

    beforeAll(async () => {
      const probe = await probeServer(target);
      available = probe.available;
      if (!available || !probe.server) return;
      capabilities = capabilitiesFor(probe.server);
      await flushDatabase(target, SOURCE_DB);
      source = await openConnection(target, SOURCE_DB);
      await run(source.connection, fixtureCommands(capabilities, Date.now()));
      expected = await snapshotDatabase(source.connection, capabilities);
    });

    afterAll(async () => {
      if (!available) return;
      await source?.close();
      await flushDatabase(target, SOURCE_DB);
      await flushDatabase(target, TARGET_DB);
    });

    it('builds a fixture covering every core type', context => {
      if (!available) context.skip();
      const types = new Set(Object.values(expected).map(key => key.type));
      expect([...types].sort()).toEqual(['hash', 'list', 'set', 'stream', 'string', 'zset']);
      expect(Object.keys(expected).length).toBeGreaterThanOrEqual(40);
    });

    for (const path of PATHS) {
      it(path.name, async context => {
        if (!available) context.skip();
        const { bytes, result } = await dumpToBuffer(source.connection, path.dump);
        expect(result.cancelled).toBe(false);
        expect(result.keysExported).toBe(Object.keys(expected).length);
        expect(result.warnings.filter(warning => warning.severity !== 'info')).toEqual([]);

        await flushDatabase(target, TARGET_DB);
        await restoreInto(target, TARGET_DB, bytes, path);

        const restored = await openConnection(target, TARGET_DB);
        try {
          const actual = await snapshotDatabase(restored.connection, capabilities);
          expectSnapshotsEqual(actual, expected, expect);
        } finally {
          await restored.close();
        }
      });
    }

    it('detects a lossy dump (negative control for the comparison itself)', async context => {
      if (!available) context.skip();
      // Each option drops something the fixture has; each must be caught, or
      // a green round trip above would prove nothing.
      for (const lossy of [
        { expiration: 'none' },
        { streamGroups: false },
        { selection: { exclude: ['list:*'] } },
      ] as const) {
        const { bytes } = await dumpToBuffer(source.connection, lossy);
        await flushDatabase(target, TARGET_DB);
        await restoreInto(target, TARGET_DB, bytes, {
          name: 'control',
          dump: {},
          restoreWith: 'library',
        });
        const restored = await openConnection(target, TARGET_DB);
        try {
          const actual = await snapshotDatabase(restored.connection, capabilities);
          expect(
            () => expectSnapshotsEqual(actual, expected, expect),
            JSON.stringify(lossy),
          ).toThrow();
        } finally {
          await restored.close();
        }
      }
    });

    it('leaves the source connection on its own database', async context => {
      if (!available) context.skip();
      await dumpToBuffer(source.connection, { databases: [0, SOURCE_DB, 5] });
      expect(source.connection.selectedDatabase).toBe(SOURCE_DB);
      const reply = await source.connection.call(['DBSIZE']);
      expect(Number(reply)).toBe(Object.keys(expected).length);
    });
  });
}

async function restoreInto(
  target: ServerTarget,
  database: number,
  bytes: Buffer,
  path: Path,
): Promise<void> {
  if (path.restoreWith === 'redis-cli') {
    const pipe = path.dump.format === 'resp';
    const { stdout } = await runCli(
      target,
      ['-n', String(database), ...(pipe ? ['--pipe'] : [])],
      bytes,
    );
    if (pipe) {
      expect(stdout).toMatch(/errors: 0, replies: \d+/);
    } else {
      expect(stdout).not.toMatch(/^\(error\)|^ERR/m);
    }
    return;
  }
  const opened = await openConnection(target, database);
  try {
    const result = await restoreRedisDump({ connection: opened.connection, source: bytes });
    expect(result.errors).toEqual([]);
    expect(result.cancelled).toBe(false);
  } finally {
    await opened.close();
  }
}
