import type { RedisConnectionInput, RedisServerErrorInfo } from '../connection/types.js';
import type { AllowedCommands } from '../security/index.js';
import type { RestoreProgressCallback } from '../utils/progress.js';
import type { CommandLocation, CommandParserOptions } from './parser.js';
import type { RedisDumpSource } from './source.js';

export interface RestoreOptions extends CommandParserOptions {
  /** Stop at the first command that fails. Defaults to `true`. */
  readonly stopOnError?: boolean;
  /**
   * `SELECT` this database before the first command, so a dump without
   * `SELECT`s (a `databases: 'current'` dump) lands where intended. When
   * omitted, commands run against whatever database the connection has
   * selected. `SELECT`s in the dump still apply, through
   * {@link databaseMapping}.
   */
  readonly database?: number;
  /**
   * Rewrites the database of every `SELECT` in the dump: `{ 0: 5 }` restores
   * what was database 0 into database 5. Unlisted databases stay as they
   * are. A function receives each source database number.
   */
  readonly databaseMapping?: Readonly<Record<number, number>> | ((database: number) => number);
  /**
   * Which commands may run. Defaults to `'restore'`, the data-only set in
   * `RESTORE_COMMANDS` — a dump cannot `FLUSHALL`, `CONFIG SET` or `EVAL`
   * unless the caller says so. Refused commands are errors, and respect
   * {@link stopOnError}.
   */
  readonly allowedCommands?: AllowedCommands;
  /**
   * Commands sent per pipeline. Defaults to 64. Pipelining is what makes a
   * restore fast, at one cost: with `stopOnError`, a failure stops the
   * restore after the pipeline it was part of, so up to this many commands
   * after the failing one have already run. Set `1` for strictly
   * sequential execution.
   */
  readonly pipelineSize?: number;
  /**
   * Put the connection back on the database it had selected before the
   * restore, and `DISCARD` a transaction the dump left open because it
   * stopped part way. Defaults to `true`.
   */
  readonly restoreSessionState?: boolean;
}

export interface RedisDumpRestoreRequest {
  readonly connection: RedisConnectionInput;
  readonly source: RedisDumpSource;
  readonly options?: RestoreOptions;
  readonly signal?: AbortSignal;
  readonly progress?: RestoreProgressCallback;
}

/** One command that parsed but failed — refused, or rejected by the server. */
export interface RestoreCommandError {
  readonly commandIndex: number;
  readonly location: CommandLocation;
  /** Truncated, credential-redacted preview of the failing command. */
  readonly commandPreview: string;
  readonly message: string;
  /**
   * `'parse'` for a line with invalid quoting (which `redis-cli` also
   * skips), `'refused'` for a command outside `allowedCommands`, `'server'`
   * for an error reply.
   */
  readonly kind: 'parse' | 'refused' | 'server';
  readonly serverError?: RedisServerErrorInfo;
}

export interface RestoreWarning {
  readonly code: string;
  readonly message: string;
  readonly commandIndex?: number;
}

export interface RedisDumpRestoreResult {
  readonly commandsExecuted: number;
  readonly commandsFailed: number;
  /** Bytes of the source consumed by the parser. */
  readonly bytesConsumed: number;
  /** The encoding the parser read. */
  readonly format: 'text' | 'resp';
  /** Target databases the restore selected, in first-selected order. */
  readonly databases: readonly number[];
  readonly errors: readonly RestoreCommandError[];
  readonly warnings: readonly RestoreWarning[];
  readonly cancelled: boolean;
}
