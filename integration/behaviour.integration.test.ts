import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dumpRedis } from '../src/api/dump.js';
import type { IoredisConnection } from '../src/ioredis.js';
import { preflightRestore } from '../src/preflight/index.js';
import {
  replyToArray,
  replyToBufferArray,
  replyToInteger,
  replyToString,
} from '../src/protocol/replies.js';
import { analyzeRedisDump } from '../src/restore/inspect.js';
import { restoreRedisDump } from '../src/restore/restoreRedisDump.js';
import { matchGlob } from '../src/selection/glob.js';
import { capabilitiesFor } from '../src/version/detect.js';
import type { RedisServerVersion } from '../src/version/types.js';
import { BufferDumpWriter } from '../src/writer/bufferWriter.js';
import { dumpToBuffer } from './helpers/dump.js';
import type { ServerTarget } from './helpers/server.js';
import {
  dbSize,
  flushDatabase,
  openConnection,
  probeServer,
  run,
  runCli,
  SERVER_TARGETS,
  selectedTargets,
} from './helpers/server.js';
import { expectSnapshotsEqual, snapshotDatabase } from './helpers/snapshot.js';

const DB_A = 3;
const DB_B = 4;
const DB_TARGET = 5;
const DB_TARGET_2 = 6;

async function withConnection<T>(
  target: ServerTarget,
  db: number,
  body: (opened: IoredisConnection) => Promise<T>,
): Promise<T> {
  const opened = await openConnection(target, db);
  try {
    return await body(opened);
  } finally {
    await opened.close();
  }
}

for (const target of selectedTargets()) {
  describe(`behaviour on ${target.label}`, () => {
    let available = false;
    let server: RedisServerVersion;

    beforeAll(async () => {
      const probe = await probeServer(target);
      available = probe.available;
      if (probe.server) server = probe.server;
    });

    const reset = async (): Promise<void> => {
      for (const db of [DB_A, DB_B, DB_TARGET, DB_TARGET_2]) {
        await flushDatabase(target, db);
      }
    };
    afterAll(async () => {
      if (available) await reset();
    });

    it('dumps several databases with SELECT and restores them through a mapping', async context => {
      if (!available) context.skip();
      await reset();
      await withConnection(target, DB_A, ({ connection }) =>
        run(connection, [
          ['SET', 'in-a', '1'],
          ['RPUSH', 'list-a', 'x', 'y'],
        ]),
      );
      await withConnection(target, DB_B, ({ connection }) =>
        run(connection, [['SET', 'in-b', '2']]),
      );

      await withConnection(target, 0, async ({ connection }) => {
        const { bytes, result } = await dumpToBuffer(connection, { databases: [DB_A, DB_B] });
        expect(result.databases.map(entry => [entry.database, entry.keysExported])).toEqual([
          [DB_A, 2],
          [DB_B, 1],
        ]);
        expect(result.requirements.databases).toEqual([DB_A, DB_B]);
        expect(connection.selectedDatabase).toBe(0);

        const restored = await restoreRedisDump({
          connection,
          source: bytes,
          options: { databaseMapping: { [DB_A]: DB_TARGET, [DB_B]: DB_TARGET_2 } },
        });
        expect(restored.errors).toEqual([]);
        expect(restored.databases).toEqual([DB_TARGET, DB_TARGET_2]);
        // Handed back on the database it started on.
        expect(connection.selectedDatabase).toBe(0);
        expect(replyToString(await connection.call(['CLIENT', 'INFO']))).toMatch(/ db=0 /);
      });
      await withConnection(target, DB_TARGET, async ({ connection }) => {
        expect(replyToString(await connection.call(['GET', 'in-a']))).toBe('1');
        expect(await dbSize(connection)).toBe(2);
      });
      await withConnection(target, DB_TARGET_2, async ({ connection }) => {
        expect(replyToString(await connection.call(['GET', 'in-b']))).toBe('2');
      });
    });

    it("'all' dumps exactly the non-empty databases", async context => {
      if (!available) context.skip();
      await reset();
      await withConnection(target, DB_B, ({ connection }) =>
        run(connection, [['SET', 'only', '1']]),
      );
      await withConnection(target, 0, async ({ connection }) => {
        const { result } = await dumpToBuffer(connection, { databases: 'all' });
        const dumped = result.databases.map(entry => entry.database);
        expect(dumped).toContain(DB_B);
        expect(dumped).not.toContain(DB_A);
      });
    });

    it('applies client-side globs exactly as SCAN MATCH does on the server', async context => {
      if (!available) context.skip();
      await reset();
      const keys = [
        'user:1',
        'user:12',
        'user:x',
        'User:1',
        'order:1',
        'u[s]er',
        'a*b',
        'a?b',
        'ab',
        'h\\llo',
        'hallo',
        'hello',
      ];
      const patterns = [
        'user:*',
        'user:?',
        'user:[0-9]*',
        '[uU]ser:*',
        'user:[^x]*',
        '*:1',
        'a\\*b',
        'a?b',
        'u\\[s\\]er',
        'h[ae]llo',
        'h[a-e]llo',
        'h\\\\llo',
        '*',
        '[',
        'user:[1',
      ];
      await withConnection(target, DB_A, async ({ connection }) => {
        await run(
          connection,
          keys.map(key => ['SET', key, '1']),
        );
        for (const pattern of patterns) {
          const reply = replyToArray(
            await connection.call(['SCAN', '0', 'MATCH', pattern, 'COUNT', 1000]),
          );
          const server = replyToBufferArray(reply[1] ?? [])
            .map(String)
            .sort();
          const client = keys.filter(key => matchGlob(pattern, key)).sort();
          expect(client, pattern).toEqual(server);
        }
      });
    });

    it('dumps only the selected keys and types', async context => {
      if (!available) context.skip();
      await reset();
      await withConnection(target, DB_A, async ({ connection }) => {
        await run(connection, [
          ['SET', 'cache:1', 'a'],
          ['SET', 'cache:2', 'b'],
          ['SET', 'cache:tmp:3', 'c'],
          ['HSET', 'cache:h', 'f', 'v'],
          ['SET', 'other', 'd'],
        ]);
        const { bytes, result } = await dumpToBuffer(connection, {
          selection: { match: 'cache:*', exclude: ['cache:tmp:*'], types: ['string'] },
        });
        expect(result.keysExported).toBe(2);
        const analysis = await analyzeRedisDump(bytes);
        expect(analysis.commandCounts).toEqual({ SET: 2 });

        const explicit = await dumpToBuffer(connection, {
          selection: { keys: ['other', 'missing', 'cache:h'] },
        });
        expect(explicit.result.keysExported).toBe(2);
        expect(explicit.result.warnings.map(warning => warning.code)).toContain('key-vanished');
      });
    });

    it('restores a hand-written redis-cli script, as redis-cli itself would', async context => {
      if (!available) context.skip();
      await reset();
      const script = [
        '',
        'SET plain value',
        'SET "quoted key" "with \\"escapes\\" \\x00\\xff\\n"',
        "SET 'single' 'it\\'s'",
        'SET mid"dle quo" x',
        'SET "unbalanced x',
        '   RPUSH   list   a   b   c   ',
        '3 INCR counter',
        'HSET h field "multi word value"',
        'quit',
        'SET after-quit never',
      ].join('\n');
      await withConnection(target, DB_A, async ({ connection }) => {
        // redis-cli skips the invalid line and carries on; so does this, when told to.
        const result = await restoreRedisDump({
          connection,
          source: script,
          options: { stopOnError: false },
        });
        expect(result.errors).toMatchObject([{ kind: 'parse', location: { line: 6 } }]);
      });
      await runCli(target, ['-n', String(DB_TARGET)], Buffer.from(script));
      const [ours, theirs] = await Promise.all([
        withConnection(target, DB_A, ({ connection }) =>
          snapshotDatabase(connection, capabilitiesFor(server)),
        ),
        withConnection(target, DB_TARGET, ({ connection }) =>
          snapshotDatabase(connection, capabilitiesFor(server)),
        ),
      ]);
      expect(Object.keys(ours)).toHaveLength(7);
      expectSnapshotsEqual(ours, theirs, expect);
    });

    it('refuses administrative commands by default and stops at the first error', async context => {
      if (!available) context.skip();
      await reset();
      await withConnection(target, DB_A, async ({ connection }) => {
        await run(connection, [['SET', 'survivor', '1']]);
        const refused = await restoreRedisDump({
          connection,
          source: 'SET a 1\nFLUSHALL\nSET b 2\n',
        });
        expect(refused.errors).toMatchObject([{ kind: 'refused', commandIndex: 1 }]);
        expect(refused.commandsExecuted).toBe(1);
        expect(replyToString(await connection.call(['GET', 'survivor']))).toBe('1');

        const serverError = await restoreRedisDump({
          connection,
          source: 'SET c 1\nRPUSH l x\nINCR l\nSET c 3\n',
          options: { stopOnError: false, pipelineSize: 1 },
        });
        expect(serverError.errors).toMatchObject([
          {
            kind: 'server',
            commandIndex: 2,
            serverError: { prefix: 'WRONGTYPE' },
            location: { line: 3 },
          },
        ]);
        expect(serverError.commandsExecuted).toBe(3);
        expect(replyToString(await connection.call(['GET', 'c']))).toBe('3');

        const stopped = await restoreRedisDump({
          connection,
          source: 'SET d 1\nINCR l\nSET d 2\n',
          options: { pipelineSize: 1 },
        });
        expect(stopped.commandsFailed).toBe(1);
        expect(stopped.commandsExecuted).toBe(1);
        expect(replyToString(await connection.call(['GET', 'd']))).toBe('1');

        const permitted = await restoreRedisDump({
          connection,
          source: 'FLUSHDB\nSET only 1\n',
          options: { allowedCommands: ['FLUSHDB', 'SET'] },
        });
        expect(permitted.errors).toEqual([]);
        expect(await dbSize(connection)).toBe(1);
      });
    });

    it('discards a transaction the dump leaves open and puts the database back', async context => {
      if (!available) context.skip();
      await reset();
      await withConnection(target, 0, async ({ connection }) => {
        const result = await restoreRedisDump({
          connection,
          source: `SELECT ${DB_A}\nMULTI\nSET queued 1\n`,
        });
        expect(result.warnings.map(warning => warning.code)).toEqual(['transaction-discarded']);
        expect(connection.selectedDatabase).toBe(0);
        expect(replyToString(await connection.call(['PING']))).toBe('PONG');
      });
      await withConnection(target, DB_A, async ({ connection }) => {
        expect(await dbSize(connection)).toBe(0);
      });
    });

    it('stops promptly when cancelled and reports it', async context => {
      if (!available) context.skip();
      await reset();
      await withConnection(target, DB_A, async ({ connection }) => {
        const commands = Array.from(
          { length: 2_000 },
          (_, index) => ['SET', `k${index}`, 'v'] as const,
        );
        await run(connection, commands);
        const controller = new AbortController();
        const writer = new BufferDumpWriter();
        let pages = 0;
        const result = await dumpRedis(
          connection,
          { scanCount: 50 },
          writer,
          event => {
            if (event.phase === 'exporting-keys' && ++pages === 3) controller.abort();
          },
          controller.signal,
        );
        expect(result.cancelled).toBe(true);
        expect(result.keysExported).toBeGreaterThan(0);
        expect(result.keysExported).toBeLessThan(2_000);
        expect(connection.selectedDatabase).toBe(DB_A);
      });
    });

    it('keeps pending entries’ delivery time and count', async context => {
      if (!available) context.skip();
      await reset();
      await withConnection(target, DB_A, async ({ connection }) => {
        await run(connection, [
          ['XADD', 's', '1-0', 'f', 'v'],
          ['XGROUP', 'CREATE', 's', 'g', '0'],
          ['XREADGROUP', 'GROUP', 'g', 'c', 'STREAMS', 's', '>'],
          ['XCLAIM', 's', 'g', 'c', '0', '1-0', 'IDLE', 3_600_000, 'RETRYCOUNT', 7, 'JUSTID'],
        ]);
        const { bytes } = await dumpToBuffer(connection);
        await flushDatabase(target, DB_TARGET);
        await withConnection(target, DB_TARGET, async ({ connection: into }) => {
          await restoreRedisDump({ connection: into, source: bytes });
          const [entry] = replyToArray(await into.call(['XPENDING', 's', 'g', '-', '+', 10]));
          const [, consumer, idle, deliveries] = replyToArray(entry ?? []);
          expect(String(consumer)).toBe('c');
          expect(replyToInteger(deliveries ?? null)).toBe(7);
          expect(Math.abs(replyToInteger(idle ?? null) - 3_600_000)).toBeLessThan(10_000);
        });
      });
    });

    it('writes module types as RESTORE payloads, with a warning', async context => {
      if (!available) context.skip();
      await reset();
      await withConnection(target, DB_A, async ({ connection }) => {
        try {
          await connection.call(['VADD', 'vectors', 'VALUES', 3, 0.1, 0.2, 0.3, 'item']);
        } catch {
          context.skip(); // No vector sets (Redis < 8.0): nothing module-typed to dump.
        }
        const { bytes, result } = await dumpToBuffer(connection);
        expect(result.warnings.map(warning => warning.code)).toContain('module-type-as-payload');
        expect(result.requirements.features).toContain('restore-payload');
        await withConnection(target, DB_TARGET, async ({ connection: into }) => {
          const restored = await restoreRedisDump({ connection: into, source: bytes });
          expect(restored.errors).toEqual([]);
          expect(replyToString(await into.call(['TYPE', 'vectors']))).toBe('vectorset');
        });

        const skipped = await dumpToBuffer(connection, { unknownTypes: 'skip' });
        expect(skipped.result.keysExported).toBe(0);
        expect(skipped.result.warnings.map(warning => warning.code)).toContain(
          'unsupported-key-type',
        );
      });
    });
  });
}

describe('across versions', () => {
  const oldest = SERVER_TARGETS.find(target => target.id === 'redis62') as ServerTarget;
  const newest = SERVER_TARGETS.find(target => target.id === 'redis80') as ServerTarget;
  const valkey = SERVER_TARGETS.find(target => target.id === 'valkey80') as ServerTarget;
  const wanted = new Set(selectedTargets().map(target => target.id));
  const runs = [oldest, newest, valkey].every(target => wanted.has(target.id));

  it.runIf(runs)(
    'a dump from the oldest server restores onto the newest, and onto Valkey',
    async context => {
      for (const target of [oldest, newest, valkey]) {
        if (!(await probeServer(target)).available) context.skip();
      }
      const commands = [
        ['SET', 's', 'v', 'PX', 3_600_000],
        ['HSET', 'h', 'a', '1', 'b', '2'],
        ['ZADD', 'z', 'inf', 'm'],
        ['XADD', 'x', '1-0', 'f', 'v'],
        ['XGROUP', 'CREATE', 'x', 'g', '0'],
      ] as const;
      await flushDatabase(oldest, DB_A);
      const bytes = await withConnection(oldest, DB_A, async ({ connection }) => {
        await run(connection, commands);
        return (await dumpToBuffer(connection)).bytes;
      });
      for (const target of [newest, valkey]) {
        await flushDatabase(target, DB_TARGET);
        await withConnection(target, DB_TARGET, async ({ connection }) => {
          const result = await restoreRedisDump({ connection, source: bytes });
          expect(result.errors).toEqual([]);
          expect(await dbSize(connection)).toBe(4);
        });
      }
    },
  );

  it.runIf(runs)(
    'preflight names what an older target lacks before anything is written',
    async context => {
      for (const target of [oldest, newest]) {
        if (!(await probeServer(target)).available) context.skip();
      }
      await flushDatabase(newest, DB_A);
      const { result } = await withConnection(newest, DB_A, async ({ connection }) => {
        await run(connection, [
          ['XADD', 'x', '1-0', 'f', 'v'],
          ['XGROUP', 'CREATE', 'x', 'g', '0'],
          ['HSET', 'h', 'f', 'v'],
          ['HPEXPIRE', 'h', 3_600_000, 'FIELDS', 1, 'f'],
        ]);
        return dumpToBuffer(connection, { strategy: 'payload' });
      });
      expect(result.requirements.features).toContain('restore-payload');
      const commandsDump = await withConnection(newest, DB_A, ({ connection }) =>
        dumpToBuffer(connection),
      );
      expect(commandsDump.result.requirements.features).toEqual(
        expect.arrayContaining(['stream-counters', 'hash-field-expiration']),
      );

      await withConnection(oldest, 0, async ({ connection }) => {
        const payload = await preflightRestore({ connection, requirements: result.requirements });
        expect(payload.compatible).toBe(false);
        expect(payload.issues.map(issue => issue.feature)).toContain('restore-payload');

        const commandsPreflight = await preflightRestore({
          connection,
          requirements: commandsDump.result.requirements,
        });
        expect(commandsPreflight.issues.map(issue => issue.feature).sort()).toEqual([
          'hash-field-expiration',
          'stream-counters',
        ]);
      });
    },
  );
});
