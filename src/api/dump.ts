import { Writable } from 'node:stream';
import { RequirementTracker } from '../compatibility/index.js';
import {
  acquireRedisConnection,
  describeKey,
  detectSelectedDatabase,
  selectDatabase,
} from '../connection/acquire.js';
import type { RedisCommand, RedisConnection, RedisConnectionInput } from '../connection/types.js';
import { ServerClock } from '../data/clock.js';
import { KeyExporter } from '../data/keyExporter.js';
import { resolveKeyExportOptions } from '../data/types.js';
import { DiagnosticCollector } from '../model/index.js';
import { encodeCommand } from '../protocol/index.js';
import { replyToString } from '../protocol/replies.js';
import { scanKeys } from '../scan/index.js';
import { isAbortError, RedisDumperError, throwIfAborted } from '../utils/errors.js';
import type { DumpProgressCallback } from '../utils/progress.js';
import {
  capabilitiesFor,
  detectServerVersion,
  MINIMUM_SUPPORTED_VERSION,
  parseKeyspace,
  versionAtLeast,
} from '../version/detect.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../version/package.js';
import type { RedisServerVersion } from '../version/types.js';
import type { DumpWriter } from '../writer/types.js';
import { StreamDumpWriter } from '../writer/streamWriter.js';
import type {
  DatabaseDumpResult,
  DatabaseSelection,
  DumpRedisOptions,
  DumpResult,
} from './types.js';

/** Output is coalesced into writes of about this size rather than one write per command. */
const OUTPUT_BUFFER_BYTES = 64 * 1024;

function toWriter(output: Writable | DumpWriter): DumpWriter {
  return output instanceof Writable ? new StreamDumpWriter(output) : output;
}

async function readKeyspace(
  connection: RedisConnection,
  signal?: AbortSignal,
): Promise<Map<number, number>> {
  return parseKeyspace(replyToString(await connection.call(['INFO', 'keyspace'], signal)));
}

function validateDatabases(selection: DatabaseSelection): void {
  if (Array.isArray(selection)) {
    for (const database of selection) {
      if (!Number.isInteger(database) || database < 0) {
        throw new RangeError(`Database numbers must be non-negative integers, got ${database}`);
      }
    }
  }
}

/**
 * Dumps a Redis server's keys as a script of Redis commands.
 *
 * The output is either `redis-cli` text (`format: 'text'`, restorable with
 * `redis-cli < dump.redis`) or RESP (`format: 'resp'`, restorable with
 * `redis-cli --pipe < dump.resp`), and restores with {@link restoreRedisDump}
 * either way. Nothing here spawns a process: everything goes through the
 * {@link RedisConnection}.
 *
 * Redis offers no snapshot a client can read from, so a dump of a server
 * taking writes is not a point-in-time image: each key is internally
 * consistent (or reported as changed), but two keys may be read at different
 * moments. See `docs/known-limitations.md`.
 *
 * The connection is put back on the database it had selected before the
 * dump, even when the dump fails or is cancelled.
 */
export async function dumpRedis(
  connectionInput: RedisConnectionInput,
  options: DumpRedisOptions,
  output: Writable | DumpWriter,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpResult> {
  throwIfAborted(signal);
  const keyOptions = resolveKeyExportOptions(options);
  const format = options.format ?? 'text';
  const databasesOption = options.databases ?? 'current';
  validateDatabases(databasesOption);

  const writer = toWriter(output);
  const diagnostics = new DiagnosticCollector();
  const requirements = new RequirementTracker();

  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let commandsWritten = 0;
  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const chunk = pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending);
    pending = [];
    pendingBytes = 0;
    await writer.write(chunk, signal);
  };
  const emit = async (command: RedisCommand): Promise<void> => {
    requirements.note(command);
    const encoded = encodeCommand(command, format, options.text);
    pending.push(encoded);
    pendingBytes += encoded.length;
    commandsWritten++;
    if (pendingBytes >= OUTPUT_BUFFER_BYTES) {
      await flush();
    }
  };
  const bytesWritten = (): number => writer.bytesWritten + pendingBytes;

  onProgress?.({ phase: 'connecting' });
  const acquired = await acquireRedisConnection(connectionInput, signal);
  const { connection } = acquired;

  const databaseResults: DatabaseDumpResult[] = [];
  let totalKeysExported = 0;
  let totalKeysSkipped = 0;
  let cancelled = false;
  let originalDatabase: number | undefined;
  let switched = false;
  let server: RedisServerVersion | undefined;

  const result = (detected: RedisServerVersion): DumpResult => ({
    bytesWritten: writer.bytesWritten,
    commandsWritten,
    keysExported: totalKeysExported,
    keysSkipped: totalKeysSkipped,
    databases: databaseResults,
    warnings: diagnostics.toArray(),
    cancelled,
    requirements: requirements.toRequirements(),
    server: detected,
  });

  try {
    onProgress?.({ phase: 'detecting-version' });
    server = await detectServerVersion(connection, signal);
    if (server.mode === 'cluster') {
      throw new RedisDumperError(
        'cluster-unsupported',
        'The server runs in cluster mode. Dump each primary node separately, through a connection to that node',
      );
    }
    if (server.mode === 'sentinel') {
      throw new RedisDumperError(
        'sentinel-unsupported',
        'The connection points at a Sentinel, which holds no data; connect to the primary it reports instead',
      );
    }
    if (!versionAtLeast(server.redisCompatibleVersion, MINIMUM_SUPPORTED_VERSION)) {
      throw new RedisDumperError(
        'unsupported-version',
        `Redis ${server.version} is older than ${MINIMUM_SUPPORTED_VERSION}, the oldest version this package dumps`,
      );
    }
    const capabilities = capabilitiesFor(server);
    const clock = await ServerClock.measure(connection, signal);

    originalDatabase = await detectSelectedDatabase(connection, signal);
    const keyspace = await readKeyspace(connection, signal);

    let databases: readonly number[];
    let selectEach: boolean;
    if (databasesOption === 'current') {
      databases = [originalDatabase ?? 0];
      selectEach = false;
    } else if (databasesOption === 'all') {
      databases = [...keyspace.keys()].sort((a, b) => a - b);
      selectEach = true;
    } else {
      databases = databasesOption;
      selectEach = true;
    }
    if (selectEach && originalDatabase === undefined) {
      diagnostics.add({
        severity: 'warning',
        code: 'selected-database-unknown',
        message:
          'Could not tell which database the connection had selected (the adapter does not report it and CLIENT INFO needs Redis 6.2); it is left on the last database dumped',
      });
    }

    if (options.header) {
      await emit([
        'ECHO',
        `${PACKAGE_NAME} ${PACKAGE_VERSION} format=${format} source=${server.flavor}/${server.version} created=${new Date().toISOString()}`,
      ]);
    }

    for (const database of databases) {
      throwIfAborted(signal);
      if (selectEach) {
        await selectDatabase(connection, database, signal);
        switched = true;
        await emit(['SELECT', database]);
      }
      const keysEstimated = keyspace.get(database) ?? 0;
      onProgress?.({
        phase: 'scanning',
        database,
        keysEstimated,
        totalKeysExported,
        bytesWritten: bytesWritten(),
      });

      const exporter = new KeyExporter({
        connection,
        capabilities,
        options: keyOptions,
        emit,
        diagnostics,
        clock,
        database,
        ...(options.selection ? { selection: options.selection } : {}),
        ...(signal ? { signal } : {}),
        onLargeKey: key =>
          onProgress?.({
            phase: 'exporting-keys',
            database,
            keyName: describeKey(key),
            totalKeysExported,
            commandsWritten,
            bytesWritten: bytesWritten(),
          }),
      });

      let keysExported = 0;
      let keysSkipped = 0;
      for await (const page of scanKeys(connection, capabilities, {
        count: keyOptions.scanCount,
        ...(options.selection ? { selection: options.selection } : {}),
        ...(options.deduplicateKeys === undefined ? {} : { deduplicate: options.deduplicateKeys }),
        ...(signal ? { signal } : {}),
      })) {
        const result = await exporter.exportPage(page);
        keysExported += result.keysExported;
        keysSkipped += result.keysSkipped;
        totalKeysExported += result.keysExported;
        totalKeysSkipped += result.keysSkipped;
        onProgress?.({
          phase: 'exporting-keys',
          database,
          keysExported,
          keysEstimated,
          totalKeysExported,
          commandsWritten,
          bytesWritten: bytesWritten(),
        });
      }
      databaseResults.push({ database, keysExported, keysSkipped });
    }

    onProgress?.({ phase: 'finalizing', totalKeysExported, bytesWritten: bytesWritten() });
    await flush();
    return result(server);
  } catch (error) {
    // Cancelled before the server even answered: nothing was written, and
    // there is no partial result worth returning.
    if (!isAbortError(error) || server === undefined) {
      throw error;
    }
    cancelled = true;
    return result(server);
  } finally {
    if (switched && originalDatabase !== undefined) {
      // Without a signal: a cancelled dump must still hand the connection back
      // on the database the caller had selected.
      await selectDatabase(connection, originalDatabase).catch(() => {});
    }
    await acquired.release();
  }
}
