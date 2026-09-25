import { toBuffer } from '../protocol/arguments.js';
import { replyToString } from '../protocol/replies.js';
import { throwIfAborted } from '../utils/errors.js';
import type {
  AcquiredRedisConnection,
  RedisCommand,
  RedisConnection,
  RedisConnectionInput,
  RedisPipelineResult,
} from './types.js';
import { isRedisConnectionSource } from './types.js';

/**
 * Normalizes a {@link RedisConnectionInput} into an acquired connection with
 * a release callback. A direct connection resolves immediately with a no-op
 * release and `dedicated: false` (the caller may be sharing it); a source is
 * asked for one physical connection through its own `acquire()`.
 */
export async function acquireRedisConnection(
  input: RedisConnectionInput,
  signal?: AbortSignal,
): Promise<AcquiredRedisConnection> {
  if (isRedisConnectionSource(input)) {
    return input.acquire(signal);
  }
  return {
    connection: input as RedisConnection,
    dedicated: false,
    release: async () => {},
  };
}

/**
 * Runs several commands through the adapter's pipeline, or one after
 * another when it has none. Either way the result has one entry per
 * command, in order, and a failing command never throws.
 */
export async function callMany(
  connection: RedisConnection,
  commands: readonly RedisCommand[],
  signal?: AbortSignal,
): Promise<readonly RedisPipelineResult[]> {
  if (commands.length === 0) {
    return [];
  }
  throwIfAborted(signal);
  if (connection.pipeline) {
    const results = await connection.pipeline(commands, signal);
    if (results.length !== commands.length) {
      throw new Error(
        `Adapter pipeline returned ${results.length} replies for ${commands.length} commands`,
      );
    }
    return results;
  }
  const results: RedisPipelineResult[] = [];
  for (const command of commands) {
    throwIfAborted(signal);
    try {
      results.push({ ok: true, reply: await connection.call(command, signal) });
    } catch (error) {
      results.push({ ok: false, error });
    }
  }
  return results;
}

/**
 * The logical database a connection currently has selected: the adapter's
 * own answer when it has one, else `CLIENT INFO` (Redis 6.2+). `undefined`
 * when neither can tell.
 */
export async function detectSelectedDatabase(
  connection: RedisConnection,
  signal?: AbortSignal,
): Promise<number | undefined> {
  if (typeof connection.selectedDatabase === 'number') {
    return connection.selectedDatabase;
  }
  try {
    const info = replyToString(await connection.call(['CLIENT', 'INFO'], signal));
    const match = /(?:^|\s)db=(\d+)(?:\s|$)/.exec(info);
    return match ? Number(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Sends `SELECT database`. */
export async function selectDatabase(
  connection: RedisConnection,
  database: number,
  signal?: AbortSignal,
): Promise<void> {
  await connection.call(['SELECT', database], signal);
}

/** Printable, bounded rendering of a key for messages and progress events. */
export function describeKey(key: Buffer | string, maxLength = 120): string {
  const text = toBuffer(key).toString('utf8');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
