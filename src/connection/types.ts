/**
 * Client-agnostic Redis connection abstraction.
 *
 * The core package never imports a Node.js driver directly. Callers provide
 * a {@link RedisConnection} (or a {@link RedisConnectionSource} that can
 * acquire one) implemented by an adapter such as `dbgate-redis-dumper/ioredis`.
 */

/**
 * One command argument. `number` is sent as its decimal text, which is what
 * every Redis command expects for counts, offsets and timestamps.
 */
export type RedisArgument = string | Buffer | number;

/**
 * One complete command: the command name followed by its arguments, exactly
 * as they are sent on the wire (`['HSET', key, field, value]`).
 */
export type RedisCommand = readonly RedisArgument[];

/**
 * A RESP2 reply.
 *
 * Bulk strings **must** arrive as `Buffer`s, never decoded strings: keys
 * and values are arbitrary bytes, and decoding them as UTF-8 would replace
 * every invalid sequence with U+FFFD — silently, and irreversibly. Status
 * replies (`+OK`) may arrive as either a `Buffer` or a `string`.
 */
export type RedisReply = Buffer | string | number | null | readonly RedisReply[];

/** The outcome of one command sent as part of a {@link RedisConnection.pipeline}. */
export type RedisPipelineResult =
  | { readonly ok: true; readonly reply: RedisReply }
  | { readonly ok: false; readonly error: unknown };

/** Structured information about a Redis error reply, extracted by an adapter. */
export interface RedisServerErrorInfo {
  /**
   * The error reply's leading word — `ERR`, `WRONGTYPE`, `NOPERM`,
   * `BUSYKEY`, `OOM`, ... — which is the only machine-readable part of a
   * Redis error.
   */
  readonly prefix?: string;
  readonly message: string;
}

/**
 * One physical Redis connection.
 *
 * "Physical" matters: `SELECT` is connection state. A dump switches the
 * connection between logical databases, so a client that silently spreads
 * commands over several sockets (or reconnects and re-selects a database of
 * its own choosing) would read keys from the wrong database. Adapters must
 * send every command over the same socket, and fail rather than reconnect
 * transparently.
 */
export interface RedisConnection {
  /** Sends one command and resolves with its reply; rejects on an error reply. */
  call(command: RedisCommand, signal?: AbortSignal): Promise<RedisReply>;

  /**
   * Sends several commands without waiting for each reply, resolving once
   * every reply is in. Order is preserved and one failing command never
   * affects the others.
   *
   * Optional, but a dump issues several commands per key, so without it
   * every key costs several network round trips. Callers fall back to
   * sequential {@link call}s when an adapter omits it.
   */
  pipeline?(
    commands: readonly RedisCommand[],
    signal?: AbortSignal,
  ): Promise<readonly RedisPipelineResult[]>;

  /**
   * The logical database this connection has selected, when the adapter
   * knows it. Used to put the connection back where it was after a dump or
   * restore that had to `SELECT` another one. When omitted, the package asks
   * the server (`CLIENT INFO`, Redis 6.2+).
   */
  readonly selectedDatabase?: number;

  /** Extracts structured error fields from a driver error, for diagnostics. */
  describeError?(error: unknown): RedisServerErrorInfo | undefined;
}

/** A connection acquired from a source, plus its release callback. */
export interface AcquiredRedisConnection {
  readonly connection: RedisConnection;
  /**
   * Whether this connection is exclusively held for the duration of the
   * operation. `false` for a bare {@link RedisConnection} the caller handed
   * over directly — it may be shared, so connection state (the selected
   * database) must be restored rather than assumed discarded.
   */
  readonly dedicated: boolean;
  /** Idempotent; safe to call more than once. */
  release(): Promise<void>;
}

/**
 * Represents a resource that must be acquired to obtain one physical
 * connection — for example a factory that duplicates a shared client.
 * Direct {@link RedisConnection} instances are borrowed by the library and
 * are never closed by it.
 */
export interface RedisConnectionSource {
  acquire(signal?: AbortSignal): Promise<AcquiredRedisConnection>;
}

/** Anything the public API accepts in place of a physical connection. */
export type RedisConnectionInput = RedisConnection | RedisConnectionSource;

export function isRedisConnectionSource(
  input: RedisConnectionInput,
): input is RedisConnectionSource {
  return typeof (input as RedisConnectionSource).acquire === 'function';
}
