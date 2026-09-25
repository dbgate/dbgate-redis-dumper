import type { DumpRequirements } from '../compatibility/index.js';
import type { KeyExportOptions } from '../data/types.js';
import type { RedisDiagnostic } from '../model/index.js';
import type { DumpFormat } from '../protocol/index.js';
import type { TextEncodingOptions } from '../protocol/textEncoding.js';
import type { DumpSelection } from '../selection/index.js';
import type { RedisServerVersion } from '../version/types.js';

/**
 * Which logical databases to dump.
 *
 * - `'current'` (default): the database the connection has selected. The
 *   dump contains no `SELECT`, so it restores into whichever database the
 *   restoring client uses — the equivalent of a single-database `mysqldump`
 *   without `USE`.
 * - `'all'`: every database `INFO keyspace` reports as non-empty, each
 *   introduced by `SELECT n`.
 * - an array of database numbers, each introduced by `SELECT n`.
 */
export type DatabaseSelection = 'current' | 'all' | readonly number[];

export interface DumpRedisOptions extends KeyExportOptions {
  /** Defaults to `'text'`; see {@link DumpFormat}. */
  readonly format?: DumpFormat;
  /** Options for the `'text'` format. */
  readonly text?: TextEncodingOptions;
  /** Defaults to `'current'`; see {@link DatabaseSelection}. */
  readonly databases?: DatabaseSelection;
  readonly selection?: DumpSelection;
  /** Drop keys `SCAN` returns twice. Defaults to `true`; see `KeyScanOptions.deduplicate`. */
  readonly deduplicateKeys?: boolean;
  /**
   * Start the dump with an `ECHO` naming the producer, source server and
   * time. Defaults to `false`.
   *
   * A dump cannot carry comments — `redis-cli` sends every non-blank line
   * to the server, `#` included — so this is the only way to label one that
   * both `redis-cli` and this package restore unchanged. It costs one
   * harmless command, and `redis-cli` prints the label as it restores.
   */
  readonly header?: boolean;
}

export interface DatabaseDumpResult {
  readonly database: number;
  readonly keysExported: number;
  readonly keysSkipped: number;
}

export interface DumpResult {
  readonly bytesWritten: number;
  readonly commandsWritten: number;
  readonly keysExported: number;
  /** Keys filtered out by type, vanished while read, changed while read, or of a skipped type. */
  readonly keysSkipped: number;
  readonly databases: readonly DatabaseDumpResult[];
  readonly warnings: readonly RedisDiagnostic[];
  /** `true` when the dump stopped because its `AbortSignal` fired; the output is then incomplete. */
  readonly cancelled: boolean;
  /** What a restore target must support; pass to `preflightRestore`. */
  readonly requirements: DumpRequirements;
  readonly server: RedisServerVersion;
}
