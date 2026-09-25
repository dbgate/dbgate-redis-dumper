import { execFile } from 'node:child_process';
import type { RedisCommand, RedisConnection } from '../../src/connection/types.js';
import type { IoredisConnection } from '../../src/ioredis.js';
import { connectIoredis } from '../../src/ioredis.js';
import { replyToString } from '../../src/protocol/replies.js';
import type { RedisServerVersion } from '../../src/version/types.js';
import { detectServerVersion } from '../../src/version/detect.js';

/**
 * One server version under test.
 *
 * `container` is the Docker container name from
 * `integration/docker-compose.yml`. It is used *only* to reach the
 * `redis-cli` (or `valkey-cli`) binary that ships inside the image, for the
 * native-interoperability tests — the library under test never invokes an
 * external process, and nothing in `src/` knows these exist.
 *
 * The `host` target is a server you run yourself (`REDIS_TEST_HOST_PORT`,
 * default 6379), exercised with the `redis-cli` on your `PATH`.
 */
export interface ServerTarget {
  readonly id: string;
  readonly label: string;
  readonly port: number;
  /** Container to `docker exec` the CLI in; `undefined` runs the CLI from the host. */
  readonly container?: string;
  readonly cli: string;
}

export const SERVER_TARGETS: readonly ServerTarget[] = [
  {
    id: 'redis62',
    label: 'Redis 6.2',
    port: 36362,
    container: 'dbgate-redis-dumper-62',
    cli: 'redis-cli',
  },
  {
    id: 'redis72',
    label: 'Redis 7.2',
    port: 36372,
    container: 'dbgate-redis-dumper-72',
    cli: 'redis-cli',
  },
  {
    id: 'redis74',
    label: 'Redis 7.4',
    port: 36374,
    container: 'dbgate-redis-dumper-74',
    cli: 'redis-cli',
  },
  {
    id: 'redis80',
    label: 'Redis 8.0',
    port: 36380,
    container: 'dbgate-redis-dumper-80',
    cli: 'redis-cli',
  },
  {
    id: 'valkey80',
    label: 'Valkey 8.0',
    port: 36390,
    container: 'dbgate-redis-dumper-valkey-80',
    cli: 'valkey-cli',
  },
];

const HOST_TARGET: ServerTarget = {
  id: 'host',
  label: 'host server',
  port: Number(process.env.REDIS_TEST_HOST_PORT ?? 6379),
  cli: process.env.REDIS_TEST_HOST_CLI ?? 'redis-cli',
};

export interface ServerConfig {
  readonly host: string;
  readonly password?: string;
  /** When true, an unreachable server is a hard failure instead of a skip. CI sets this. */
  readonly required: boolean;
  readonly waitMs: number;
}

export function readServerConfig(): ServerConfig {
  return {
    host: process.env.REDIS_TEST_HOST ?? '127.0.0.1',
    ...(process.env.REDIS_TEST_PASSWORD ? { password: process.env.REDIS_TEST_PASSWORD } : {}),
    required: process.env.REDIS_TEST_REQUIRED === '1',
    waitMs: Number(process.env.REDIS_TEST_WAIT_MS ?? 30_000),
  };
}

/**
 * Targets to exercise, filtered by `REDIS_TEST_TARGETS` (comma-separated
 * ids). `host` is only included when named there.
 */
export function selectedTargets(): readonly ServerTarget[] {
  const requested = process.env.REDIS_TEST_TARGETS;
  if (!requested) {
    return SERVER_TARGETS;
  }
  const ids = new Set(requested.split(',').map(id => id.trim()));
  return [...SERVER_TARGETS, HOST_TARGET].filter(target => ids.has(target.id));
}

/** Opens one dedicated connection through this package's own ioredis adapter. */
export async function openConnection(target: ServerTarget, db = 0): Promise<IoredisConnection> {
  const config = readServerConfig();
  return connectIoredis({
    host: config.host,
    port: target.port,
    db,
    connectTimeout: 5_000,
    ...(config.password ? { password: config.password } : {}),
  });
}

export interface ServerAvailability {
  readonly available: boolean;
  readonly reason?: string;
  readonly server?: RedisServerVersion;
}

const availabilityByTarget = new Map<string, Promise<ServerAvailability>>();

async function attemptProbe(target: ServerTarget): Promise<ServerAvailability> {
  const config = readServerConfig();
  const deadline = Date.now() + config.waitMs;
  let lastError = 'unknown error';
  for (;;) {
    let opened: IoredisConnection | null = null;
    try {
      opened = await openConnection(target);
      return { available: true, server: await detectServerVersion(opened.connection) };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      await opened?.close().catch(() => {});
    }
    if (Date.now() >= deadline) {
      return {
        available: false,
        reason:
          `No server reachable at ${config.host}:${target.port} (${target.label}) after ${config.waitMs}ms — ${lastError}. ` +
          'Start them with "npm run docker:up", or run your own and set REDIS_TEST_TARGETS=host.',
      };
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

/**
 * Probes one server once per process. Suites gate themselves on the
 * result: absent a server they skip, unless `REDIS_TEST_REQUIRED=1`, which
 * turns absence into an error so the suites can never silently no-op in CI.
 */
export function probeServer(target: ServerTarget): Promise<ServerAvailability> {
  let probe = availabilityByTarget.get(target.id);
  if (!probe) {
    probe = attemptProbe(target).then(availability => {
      if (!availability.available) {
        if (readServerConfig().required) {
          throw new Error(`REDIS_TEST_REQUIRED=1 but ${availability.reason}`);
        }
        console.warn(`\n[integration] SKIPPING ${target.label}: ${availability.reason}\n`);
      }
      return availability;
    });
    availabilityByTarget.set(target.id, probe);
  }
  return probe;
}

/**
 * Runs commands one by one, failing loudly on the first error.
 *
 * Deliberately does NOT go through `restoreRedisDump`: a fixture must be
 * created by something independent of the code under test, or a parsing
 * bug could corrupt the fixture and mask itself.
 */
export async function run(
  connection: RedisConnection,
  commands: readonly RedisCommand[],
): Promise<void> {
  for (const [index, command] of commands.entries()) {
    try {
      await connection.call(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Fixture command #${index} (${String(command[0])}) failed: ${message}`);
    }
  }
}

export async function flushDatabase(target: ServerTarget, db: number): Promise<void> {
  const opened = await openConnection(target, db);
  try {
    await opened.connection.call(['FLUSHDB']);
  } finally {
    await opened.close();
  }
}

export async function dbSize(connection: RedisConnection): Promise<number> {
  return Number(replyToString(await connection.call(['DBSIZE'])));
}

/**
 * Runs the server's own CLI with `stdin`, exactly as `redis-cli < dump`
 * would. **Only integration tests may use this**: its purpose is to prove
 * that dumps from this library restore through the real client. Nothing
 * under `src/` shells out, and `tests/packageBoundaries.test.ts` keeps it so.
 */
export function runCli(
  target: ServerTarget,
  args: readonly string[],
  stdin: Buffer,
): Promise<{ stdout: string; stderr: string }> {
  const config = readServerConfig();
  const cliArgs = [
    '-h',
    target.container ? '127.0.0.1' : config.host,
    '-p',
    String(target.container ? 6379 : target.port),
    ...(config.password ? ['-a', config.password, '--no-auth-warning'] : []),
    ...args,
  ];
  const [file, argv] = target.container
    ? ['docker', ['exec', '-i', target.container, target.cli, ...cliArgs]]
    : [target.cli, cliArgs];
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      argv,
      { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${file} ${argv.join(' ')} failed: ${stderr || error.message}`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
    child.stdin?.end(stdin);
  });
}
