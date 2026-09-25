import type { RedisArgument, RedisConnection, RedisReply } from '../connection/types.js';
import { describeKey } from '../connection/acquire.js';
import type { DiagnosticCollector } from '../model/index.js';
import {
  replyToArray,
  replyToBuffer,
  replyToBufferArray,
  replyToInteger,
  replyToMap,
  replyToString,
} from '../protocol/replies.js';
import { throwIfAborted } from '../utils/errors.js';
import type { RedisServerCapabilities } from '../version/types.js';
import type { CommandSink } from './chunker.js';
import type { ServerClock } from './clock.js';
import { nextStreamId } from './streamIds.js';
import type { ResolvedKeyExportOptions } from './types.js';

/** Name of the throwaway group used to create a stream that has never held an entry. */
export const PLACEHOLDER_GROUP = '__dbgate_redis_dumper_mkstream__';

export interface StreamExportContext {
  readonly connection: RedisConnection;
  readonly capabilities: RedisServerCapabilities;
  readonly options: ResolvedKeyExportOptions;
  readonly emit: CommandSink;
  readonly diagnostics: DiagnosticCollector;
  readonly clock: ServerClock;
  readonly database: number;
  readonly signal?: AbortSignal;
}

function optionalString(value: RedisReply | undefined): string | undefined {
  return value === undefined || value === null ? undefined : replyToString(value);
}

function optionalInteger(value: RedisReply | undefined): number | undefined {
  return value === undefined || value === null ? undefined : replyToInteger(value);
}

/**
 * Writes one stream: its entries, its last-generated id and counters, and
 * — unless disabled — every consumer group with its consumers and pending
 * entries list.
 *
 * Order matters on restore. Entries come first, in id order, because
 * `XADD` with an explicit id only accepts ids above the stream's current
 * top. `XSETID` then moves the last id past entries that were deleted.
 * Groups come last, because `XCLAIM ... FORCE` only recreates a pending
 * entry for a message that exists in the stream.
 *
 * Returns `false` when the key vanished before it could be read.
 */
export async function exportStream(context: StreamExportContext, key: Buffer): Promise<boolean> {
  const { connection, options, emit, signal } = context;

  let info: Map<string, RedisReply>;
  try {
    info = replyToMap(await connection.call(['XINFO', 'STREAM', key], signal));
  } catch (error) {
    if (/no such key/i.test(error instanceof Error ? error.message : String(error))) {
      return false;
    }
    throw error;
  }
  const lastGeneratedId = optionalString(info.get('last-generated-id')) ?? '0-0';
  const entriesAdded = optionalInteger(info.get('entries-added'));
  const maxDeletedId = optionalString(info.get('max-deleted-entry-id'));

  if (options.replace) {
    await emit(['DEL', key]);
  }

  let entriesWritten = 0;
  let start = '-';
  for (;;) {
    throwIfAborted(signal);
    const page = replyToArray(
      await connection.call(['XRANGE', key, start, '+', 'COUNT', options.batchSize], signal),
    );
    for (const entry of page) {
      const [idReply, fieldsReply] = replyToArray(entry);
      const id = replyToBuffer(idReply ?? null);
      const fields = replyToBufferArray(fieldsReply ?? []);
      await emit(['XADD', key, id, ...fields]);
      entriesWritten++;
      start = nextStreamId(id.toString('latin1'));
    }
    if (page.length < options.batchSize) {
      break;
    }
  }

  if (entriesWritten === 0) {
    if (lastGeneratedId === '0-0') {
      // Never held an entry: only a group's MKSTREAM creates such a stream.
      await emit(['XGROUP', 'CREATE', key, PLACEHOLDER_GROUP, '0', 'MKSTREAM']);
      await emit(['XGROUP', 'DESTROY', key, PLACEHOLDER_GROUP]);
    } else {
      // Held entries that were all deleted: add one at the last id and trim
      // it away in the same command, which leaves an empty stream whose last
      // id is exactly the source's. XSETID below fixes the counters.
      await emit(['XADD', key, 'MAXLEN', '0', lastGeneratedId, 'x', '']);
    }
  }

  const setId: RedisArgument[] = ['XSETID', key, lastGeneratedId];
  if (context.capabilities.streamCounters && entriesAdded !== undefined && maxDeletedId) {
    setId.push('ENTRIESADDED', entriesAdded, 'MAXDELETEDID', maxDeletedId);
  }
  await emit(setId);

  if (options.streamGroups) {
    await exportGroups(context, key);
  }
  return true;
}

async function exportGroups(context: StreamExportContext, key: Buffer): Promise<void> {
  const { connection, options, emit, signal, clock } = context;
  const groups = replyToArray(await connection.call(['XINFO', 'GROUPS', key], signal)).map(
    replyToMap,
  );

  for (const group of groups) {
    throwIfAborted(signal);
    const name = replyToBuffer(group.get('name') ?? null);
    const lastDeliveredId = optionalString(group.get('last-delivered-id')) ?? '0-0';
    const entriesRead = optionalInteger(group.get('entries-read'));

    const create: RedisArgument[] = ['XGROUP', 'CREATE', key, name, lastDeliveredId];
    if (context.capabilities.streamCounters && entriesRead !== undefined) {
      create.push('ENTRIESREAD', entriesRead);
    }
    await emit(create);

    const consumers = replyToArray(
      await connection.call(['XINFO', 'CONSUMERS', key, name], signal),
    ).map(replyToMap);
    for (const consumer of consumers) {
      await emit([
        'XGROUP',
        'CREATECONSUMER',
        key,
        name,
        replyToBuffer(consumer.get('name') ?? null),
      ]);
    }
    if (consumers.length > 0) {
      context.diagnostics.addOnce({
        severity: 'info',
        code: 'stream-consumer-activity-reset',
        message:
          "Stream consumers are recreated, but a consumer's seen-time and active-time cannot be set by any command: they restart from the moment of restore",
        database: context.database,
        key: describeKey(key),
      });
    }

    // The pending entries list, paged in id order. XCLAIM ... FORCE puts an
    // entry back into the PEL under its consumer, with its delivery count
    // and delivery time — which is what consumers use to decide on retries.
    let start = '-';
    for (;;) {
      throwIfAborted(signal);
      const page = replyToArray(
        await connection.call(['XPENDING', key, name, start, '+', options.batchSize], signal),
      );
      const now = clock.now();
      for (const pending of page) {
        const [idReply, consumerReply, idleReply, deliveriesReply] = replyToArray(pending);
        const id = replyToBuffer(idReply ?? null);
        const idle = replyToInteger(idleReply ?? null);
        const deliveries = replyToInteger(deliveriesReply ?? null);
        const timing: RedisArgument[] =
          options.expiration === 'absolute' ? ['TIME', now - idle] : ['IDLE', idle];
        await emit([
          'XCLAIM',
          key,
          name,
          replyToBuffer(consumerReply ?? null),
          '0',
          id,
          ...timing,
          'RETRYCOUNT',
          deliveries,
          'FORCE',
          'JUSTID',
        ]);
        start = nextStreamId(id.toString('latin1'));
      }
      if (page.length < options.batchSize) {
        break;
      }
    }
  }
}
