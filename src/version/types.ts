/** Which server implementation answered. Valkey is the BSD-licensed fork of Redis 7.2.4. */
export type RedisServerFlavor = 'redis' | 'valkey';

export interface RedisServerVersion {
  readonly flavor: RedisServerFlavor;
  /** The flavor's own version string, e.g. `7.2.5` for Redis or `8.0.1` for Valkey. */
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /**
   * The Redis version this server is command-compatible with. Equal to
   * {@link version} for Redis; for Valkey, the `redis_version` it reports
   * (always `7.2.4`), since Valkey forked from that release.
   */
  readonly redisCompatibleVersion: string;
  /** `standalone`, `cluster` or `sentinel`, from `INFO server`'s `redis_mode`. */
  readonly mode: string;
}

/**
 * Commands and options the dump relies on, derived once from the server
 * version. Each flag names the release that introduced it.
 */
export interface RedisServerCapabilities {
  /** `SCAN ... TYPE` (Redis 6.0). */
  readonly scanType: boolean;
  /** `PEXPIRETIME` (Redis 7.0): an absolute expiry, read exactly rather than computed. */
  readonly pexpireTime: boolean;
  /** `CLIENT INFO` (Redis 6.2). */
  readonly clientInfo: boolean;
  /** `XGROUP CREATECONSUMER` (Redis 6.2). */
  readonly xgroupCreateConsumer: boolean;
  /**
   * Stream counters introduced in Redis 7.0: `entries-added` and
   * `max-deleted-entry-id` (`XSETID ... ENTRIESADDED ... MAXDELETEDID`) and a
   * group's `entries-read` (`XGROUP CREATE ... ENTRIESREAD`).
   */
  readonly streamCounters: boolean;
  /** Per-field hash expiration: `HPEXPIRETIME`/`HPEXPIREAT` (Redis 7.4, Valkey 9.0). */
  readonly hashFieldExpiration: boolean;
}
