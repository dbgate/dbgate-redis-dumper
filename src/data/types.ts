/**
 * How a key's time-to-live is written.
 *
 * - `'absolute'` (default): `PEXPIREAT` with the key's exact expiry instant,
 *   the same thing an RDB file stores. A key restored after that instant
 *   is gone immediately — which is what it would be on the source, too.
 * - `'relative'`: `PEXPIRE` with the time remaining when the key was read.
 *   The key gets its full remaining lifetime again, counted from restore.
 * - `'none'`: expiries are dropped and every key is restored persistent.
 */
export type ExpirationMode = 'absolute' | 'relative' | 'none';

/**
 * How values are written.
 *
 * - `'commands'` (default): each key is rebuilt with ordinary commands
 *   (`SET`, `HSET`, `RPUSH`, `SADD`, `ZADD`, `XADD`, ...). Readable, and
 *   restorable onto any version of Redis or Valkey that knows the commands.
 * - `'payload'`: every key is written as `RESTORE key ttl <DUMP payload>`.
 *   Exact down to the internal encoding, and handles module types, but the
 *   payload is an RDB fragment: a server only accepts payloads of its own
 *   RDB version or older, so the dump may not restore onto an older server.
 */
export type ValueStrategy = 'commands' | 'payload';

/**
 * What happens to keys whose type the `'commands'` strategy cannot rebuild
 * — module types such as RedisJSON's `ReJSON-RL` or Redis 8's `vectorset`.
 *
 * - `'payload'` (default): written as `RESTORE` payloads, with a warning.
 *   A dump that silently drops a module's data is a trap.
 * - `'skip'`: left out, with a warning naming the type.
 */
export type UnknownTypePolicy = 'payload' | 'skip';

export interface KeyExportOptions {
  /** Defaults to `'commands'`; see {@link ValueStrategy}. */
  readonly strategy?: ValueStrategy;
  /** Defaults to `'payload'`; see {@link UnknownTypePolicy}. */
  readonly unknownTypes?: UnknownTypePolicy;
  /** Defaults to `'absolute'`; see {@link ExpirationMode}. */
  readonly expiration?: ExpirationMode;
  /**
   * Replace whatever already exists under the same key on restore: `DEL`
   * before rebuilding a collection, `RESTORE ... REPLACE` for payloads.
   * Defaults to `true`, the equivalent of `mysqldump`'s `DROP TABLE IF
   * EXISTS`. With `false`, restoring onto a non-empty database *merges*
   * collections into existing keys of the same name.
   */
  readonly replace?: boolean;
  /**
   * Elements per read and per written command: hash fields, list items,
   * set members, sorted-set members, stream entries. Defaults to 128.
   * Collections with at most this many elements are read in one command;
   * larger ones are streamed in chunks of this size, so no single key needs
   * more than one chunk in memory.
   */
  readonly batchSize?: number;
  /**
   * A written command is flushed once its arguments reach this many bytes,
   * even before {@link batchSize} elements. Strings longer than this are
   * read with `GETRANGE` and written as `SET` plus `APPEND`s of this size,
   * so a 500 MB value never has to be held in memory whole. Defaults to
   * 1 MiB.
   */
  readonly maxCommandBytes?: number;
  /**
   * Keys per `SCAN` page, passed as its `COUNT` hint and used as the unit of
   * pipelining: one page costs three or four round trips, however many
   * keys it holds. Defaults to 1000.
   */
  readonly scanCount?: number;
  /**
   * Write per-field hash expirations (`HPEXPIREAT`) on servers that have them
   * (Redis 7.4+, Valkey 9.0+). Defaults to `true`.
   */
  readonly hashFieldExpiration?: boolean;
  /**
   * Write stream consumer groups, their consumers, and each group's pending
   * entries list. Defaults to `true`. Without it only entries and the
   * stream's last ID are written.
   */
  readonly streamGroups?: boolean;
}

/** {@link KeyExportOptions} with every default applied. */
export interface ResolvedKeyExportOptions {
  readonly strategy: ValueStrategy;
  readonly unknownTypes: UnknownTypePolicy;
  readonly expiration: ExpirationMode;
  readonly replace: boolean;
  readonly batchSize: number;
  readonly maxCommandBytes: number;
  readonly scanCount: number;
  readonly hashFieldExpiration: boolean;
  readonly streamGroups: boolean;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

export function resolveKeyExportOptions(options: KeyExportOptions = {}): ResolvedKeyExportOptions {
  return {
    strategy: options.strategy ?? 'commands',
    unknownTypes: options.unknownTypes ?? 'payload',
    expiration: options.expiration ?? 'absolute',
    replace: options.replace ?? true,
    batchSize: positiveInteger(options.batchSize, 128, 'batchSize'),
    maxCommandBytes: positiveInteger(options.maxCommandBytes, 1024 * 1024, 'maxCommandBytes'),
    scanCount: positiveInteger(options.scanCount, 1000, 'scanCount'),
    hashFieldExpiration: options.hashFieldExpiration ?? true,
    streamGroups: options.streamGroups ?? true,
  };
}
