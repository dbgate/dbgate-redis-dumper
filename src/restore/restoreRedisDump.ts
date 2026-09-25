import {
  acquireRedisConnection,
  callMany,
  detectSelectedDatabase,
  selectDatabase,
} from '../connection/acquire.js';
import type { RedisCommand, RedisConnection, RedisServerErrorInfo } from '../connection/types.js';
import { argumentText, commandName } from '../protocol/arguments.js';
import { checkCommandAllowed, previewCommand } from '../security/index.js';
import { errorMessage, isAbortError, throwIfAborted } from '../utils/errors.js';
import type { ParsedCommand } from './parser.js';
import { CommandParser, streamRedisCommands } from './parser.js';
import type {
  RedisDumpRestoreRequest,
  RedisDumpRestoreResult,
  RestoreCommandError,
  RestoreWarning,
} from './types.js';

const DEFAULT_PIPELINE_SIZE = 64;
/** A pipeline is also sent once its commands add up to this many bytes. */
const PIPELINE_BYTES = 4 * 1024 * 1024;

function describeServerError(
  connection: RedisConnection,
  error: unknown,
): RedisServerErrorInfo | undefined {
  const described = connection.describeError?.(error);
  if (described) {
    return described;
  }
  const message = errorMessage(error);
  const prefix = /^([A-Z][A-Z_]+)\s/.exec(message)?.[1];
  return prefix ? { prefix, message } : undefined;
}

function commandBytes(argv: readonly Buffer[]): number {
  let total = 0;
  for (const argument of argv) {
    total += argument.length;
  }
  return total;
}

/**
 * Restores a dump — this package's, or any `redis-cli` script or RESP
 * mass-insertion file — by streaming it command by command to the server.
 *
 * The source is parsed incrementally and sent in pipelines, so a
 * multi-gigabyte dump restores in constant memory and without a round trip
 * per command. Only data commands run unless `allowedCommands` says
 * otherwise. The connection is handed back on the database it had selected
 * and outside any transaction, even when the restore fails or is cancelled.
 */
export async function restoreRedisDump(
  request: RedisDumpRestoreRequest,
): Promise<RedisDumpRestoreResult> {
  const { options = {}, signal, progress } = request;
  throwIfAborted(signal);
  const stopOnError = options.stopOnError ?? true;
  const pipelineSize = options.pipelineSize ?? DEFAULT_PIPELINE_SIZE;
  if (!Number.isInteger(pipelineSize) || pipelineSize < 1) {
    throw new RangeError(`pipelineSize must be a positive integer, got ${pipelineSize}`);
  }
  const allowed = options.allowedCommands ?? 'restore';
  const restoreSessionState = options.restoreSessionState ?? true;
  const mapDatabase = (database: number): number => {
    const mapping = options.databaseMapping;
    if (!mapping) return database;
    if (typeof mapping === 'function') return mapping(database);
    return mapping[database] ?? database;
  };

  progress?.({ phase: 'connecting' });
  const acquired = await acquireRedisConnection(request.connection, signal);
  const { connection } = acquired;

  const errors: RestoreCommandError[] = [];
  const warnings: RestoreWarning[] = [];
  const databases: number[] = [];
  const parser = new CommandParser({ ...options, invalidLines: 'report' });
  let commandsExecuted = 0;
  let cancelled = false;
  let stopped = false;
  let selectedByRestore = false;
  let inTransaction = false;
  let currentDatabase: number | undefined;
  let originalDatabase: number | undefined;

  const noteDatabase = (database: number): void => {
    currentDatabase = database;
    selectedByRestore = true;
    if (!databases.includes(database)) {
      databases.push(database);
    }
  };

  const fail = (parsed: ParsedCommand, error: RestoreCommandError): void => {
    errors.push(error);
    progress?.({
      phase: 'executing',
      commandsProcessed: commandsExecuted + errors.length,
      bytesConsumed: parser.bytesConsumed,
      error: {
        commandIndex: parsed.index,
        location: {
          offset: parsed.location.offset,
          ...(parsed.location.line ? { line: parsed.location.line } : {}),
        },
        commandPreview: error.commandPreview,
        message: error.message,
      },
    });
    if (stopOnError) {
      stopped = true;
    }
  };

  let batch: { parsed: ParsedCommand; command: RedisCommand }[] = [];
  let batchBytes = 0;

  const sendBatch = async (): Promise<void> => {
    if (batch.length === 0) {
      return;
    }
    const sending = batch;
    batch = [];
    batchBytes = 0;
    const results = await callMany(
      connection,
      sending.map(item => item.command),
      signal,
    );
    sending.forEach((item, at) => {
      const result = results[at];
      const name = commandName(item.command);
      if (result?.ok) {
        commandsExecuted++;
        if (name === 'SELECT') {
          noteDatabase(Number(argumentText(item.command, 1)));
        } else if (name === 'MULTI') {
          inTransaction = true;
        } else if (name === 'EXEC' || name === 'DISCARD') {
          inTransaction = false;
        }
        return;
      }
      if (name === 'EXEC' || name === 'DISCARD') {
        inTransaction = false;
      }
      const serverError = describeServerError(connection, result?.error);
      fail(item.parsed, {
        commandIndex: item.parsed.index,
        location: item.parsed.location,
        commandPreview: previewCommand(item.command),
        message: errorMessage(result?.error),
        kind: 'server',
        ...(serverError ? { serverError } : {}),
      });
    });
    progress?.({
      phase: 'executing',
      commandsProcessed: commandsExecuted + errors.length,
      bytesConsumed: parser.bytesConsumed,
      ...(currentDatabase === undefined ? {} : { database: currentDatabase }),
    });
  };

  try {
    originalDatabase = await detectSelectedDatabase(connection, signal);
    currentDatabase = originalDatabase;
    if (options.database !== undefined) {
      await selectDatabase(connection, options.database, signal);
      noteDatabase(options.database);
    }

    for await (const parsed of streamRedisCommands(request.source, options, parser)) {
      throwIfAborted(signal);
      if (parsed.invalid !== undefined) {
        // redis-cli prints "Invalid argument(s)" and moves on; so does this,
        // unless stopOnError says to stop.
        await sendBatch();
        fail(parsed, {
          commandIndex: parsed.index,
          location: parsed.location,
          commandPreview: '',
          message: `Invalid argument(s): ${parsed.invalid}`,
          kind: 'parse',
        });
        if (stopped) break;
        continue;
      }
      let command: RedisCommand = parsed.argv;
      const name = commandName(command);

      const refusal = checkCommandAllowed(command, allowed);
      if (refusal) {
        await sendBatch();
        fail(parsed, {
          commandIndex: parsed.index,
          location: parsed.location,
          commandPreview: previewCommand(command),
          message: refusal,
          kind: 'refused',
        });
        if (stopped) break;
        continue;
      }

      if (name === 'SELECT') {
        const source = Number(argumentText(command, 1));
        if (Number.isInteger(source) && source >= 0) {
          command = ['SELECT', mapDatabase(source)];
        }
      }

      batch.push({ parsed, command });
      batchBytes += commandBytes(parsed.argv);
      if (batch.length >= pipelineSize || batchBytes >= PIPELINE_BYTES) {
        await sendBatch();
        if (stopped) break;
      }
    }
    if (!stopped) {
      await sendBatch();
    }
    if (parser.endedWithoutNewline) {
      warnings.push({
        code: 'missing-final-newline',
        message:
          'The last line of the dump has no newline. It was executed, as redis-cli would, but a dump that was cut off also looks like this: check that the file is complete',
      });
    }
  } catch (error) {
    if (!isAbortError(error)) {
      throw error;
    }
    cancelled = true;
  } finally {
    progress?.({ phase: 'finalizing', commandsProcessed: commandsExecuted + errors.length });
    if (restoreSessionState) {
      // Without a signal: a cancelled restore must still clean up.
      if (inTransaction) {
        await connection.call(['DISCARD']).catch(() => {});
        warnings.push({
          code: 'transaction-discarded',
          message: 'The restore stopped inside MULTI; the open transaction was discarded',
        });
      }
      if (selectedByRestore && currentDatabase !== originalDatabase) {
        if (originalDatabase === undefined) {
          warnings.push({
            code: 'selected-database-unknown',
            message: `Could not tell which database the connection had selected before the restore; it is left on database ${currentDatabase}`,
          });
        } else {
          await selectDatabase(connection, originalDatabase).catch(() => {});
        }
      }
    }
    await acquired.release();
  }

  return {
    commandsExecuted,
    commandsFailed: errors.length,
    bytesConsumed: parser.bytesConsumed,
    format: parser.detectedFormat ?? 'text',
    databases,
    errors,
    warnings,
    cancelled,
  };
}
