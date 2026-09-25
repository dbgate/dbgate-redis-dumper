import type { RedisConnection, RedisReply } from '../../src/connection/types.js';
import {
  replyToArray,
  replyToBuffer,
  replyToBufferArray,
  replyToInteger,
  replyToMap,
  replyToString,
} from '../../src/protocol/replies.js';
import type { RedisServerCapabilities } from '../../src/version/types.js';

/**
 * A database's full logical content, in a form `expect().toEqual()` can
 * compare: every key and value hex-encoded (so binary compares exactly and
 * diffs stay printable), collections in a canonical order, and expiries as
 * absolute instants that tests compare within a tolerance.
 *
 * Read with plain commands, independently of the dump code under test.
 */
export interface KeySnapshot {
  readonly type: string;
  readonly value: unknown;
  /** Absolute expiry in Unix ms, or `null` when persistent. */
  readonly expiresAt: number | null;
}

export type DatabaseSnapshot = Record<string, KeySnapshot>;

const hex = (buffer: Buffer): string => buffer.toString('hex');

async function readValue(
  connection: RedisConnection,
  key: Buffer,
  type: string,
  capabilities: RedisServerCapabilities,
): Promise<unknown> {
  const call = (...args: (string | Buffer | number)[]): Promise<RedisReply> =>
    connection.call(args);
  switch (type) {
    case 'string':
      return hex(replyToBuffer(await call('GET', key)));
    case 'hash': {
      const items = replyToBufferArray(await call('HGETALL', key));
      const fields: [string, string][] = [];
      for (let at = 0; at < items.length; at += 2) {
        fields.push([hex(items[at] as Buffer), hex(items[at + 1] as Buffer)]);
      }
      fields.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (!capabilities.hashFieldExpiration) {
        return { fields };
      }
      const names = items.filter((_, at) => at % 2 === 0);
      const expiries = replyToArray(
        await call('HPEXPIRETIME', key, 'FIELDS', names.length, ...names),
      ).map(replyToInteger);
      const fieldExpiries = names
        .map((name, at) => [hex(name), expiries[at] as number] as const)
        .filter(([, instant]) => instant >= 0)
        .sort(([a], [b]) => (a < b ? -1 : 1));
      return { fields, fieldExpiries };
    }
    case 'list':
      return replyToBufferArray(await call('LRANGE', key, 0, -1)).map(hex);
    case 'set':
      return replyToBufferArray(await call('SMEMBERS', key))
        .map(hex)
        .sort();
    case 'zset': {
      const items = replyToBufferArray(await call('ZRANGE', key, 0, -1, 'WITHSCORES'));
      const members: [string, string][] = [];
      for (let at = 0; at < items.length; at += 2) {
        members.push([hex(items[at] as Buffer), (items[at + 1] as Buffer).toString('latin1')]);
      }
      return members;
    }
    case 'stream': {
      const info = replyToMap(await call('XINFO', 'STREAM', key));
      const entries = replyToArray(await call('XRANGE', key, '-', '+')).map(entry => {
        const [id, fields] = replyToArray(entry);
        return [replyToString(id ?? null), replyToBufferArray(fields ?? []).map(hex)];
      });
      const groups = [];
      for (const group of replyToArray(await call('XINFO', 'GROUPS', key)).map(replyToMap)) {
        const name = replyToBuffer(group.get('name') ?? null);
        const consumers = replyToArray(await call('XINFO', 'CONSUMERS', key, name))
          .map(replyToMap)
          .map(consumer => ({
            name: hex(replyToBuffer(consumer.get('name') ?? null)),
            pending: replyToInteger(consumer.get('pending') ?? null),
          }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        const pending = replyToArray(await call('XPENDING', key, name, '-', '+', 1000)).map(
          item => {
            const [id, consumer, idle, deliveries] = replyToArray(item);
            return {
              id: replyToString(id ?? null),
              consumer: hex(replyToBuffer(consumer ?? null)),
              deliveries: replyToInteger(deliveries ?? null),
              // Idle time is compared by the tests with a tolerance, not exactly.
              idle: replyToInteger(idle ?? null),
            };
          },
        );
        const entriesRead = group.get('entries-read');
        groups.push({
          name: hex(name),
          lastDeliveredId: replyToString(group.get('last-delivered-id') ?? null),
          entriesRead:
            entriesRead === undefined || entriesRead === null ? null : replyToInteger(entriesRead),
          consumers,
          pending,
        });
      }
      const optional = (field: string): string | null => {
        const value = info.get(field);
        return value === undefined || value === null ? null : replyToString(value);
      };
      return {
        entries,
        lastGeneratedId: optional('last-generated-id'),
        entriesAdded: optional('entries-added'),
        maxDeletedEntryId: optional('max-deleted-entry-id'),
        groups,
      };
    }
    default:
      return hex(replyToBuffer(await call('DUMP', key)));
  }
}

export async function snapshotDatabase(
  connection: RedisConnection,
  capabilities: RedisServerCapabilities,
): Promise<DatabaseSnapshot> {
  const keys: Buffer[] = [];
  let cursor = '0';
  do {
    const reply = replyToArray(await connection.call(['SCAN', cursor, 'COUNT', 1000]));
    cursor = replyToString(reply[0] ?? null);
    keys.push(...replyToBufferArray(reply[1] ?? []));
  } while (cursor !== '0');

  const now = Date.now();
  const snapshot: DatabaseSnapshot = {};
  for (const key of keys.sort(Buffer.compare)) {
    const type = replyToString(await connection.call(['TYPE', key]));
    const pttl = replyToInteger(await connection.call(['PTTL', key]));
    snapshot[hex(key)] = {
      type,
      value: await readValue(connection, key, type, capabilities),
      expiresAt: pttl >= 0 ? now + pttl : null,
    };
  }
  return snapshot;
}

/**
 * Splits a snapshot into the part compared exactly and the timing values
 * (key expiries, pending-entry idle times) compared within `toleranceMs`,
 * since they are relative to when each side was read.
 */
export function expectSnapshotsEqual(
  actual: DatabaseSnapshot,
  expected: DatabaseSnapshot,
  expect: (
    value: unknown,
    message?: string,
  ) => { toEqual(other: unknown): void; toBeLessThanOrEqual(n: number): void },
  toleranceMs = 5_000,
): void {
  const strip = (snapshot: DatabaseSnapshot): unknown =>
    Object.fromEntries(
      Object.entries(snapshot).map(([key, value]) => [
        key,
        {
          type: value.type,
          persistent: value.expiresAt === null,
          value: stripIdle(value.value),
        },
      ]),
    );
  expect(strip(actual)).toEqual(strip(expected));
  for (const [key, value] of Object.entries(expected)) {
    const other = actual[key];
    if (value.expiresAt !== null && other?.expiresAt != null) {
      expect(Math.abs(other.expiresAt - value.expiresAt), `expiry of ${key}`).toBeLessThanOrEqual(
        toleranceMs,
      );
    }
    const fields = fieldExpiries(value.value);
    const otherFields = fieldExpiries(other?.value);
    fields.forEach(([field, instant], at) => {
      const restored = otherFields[at]?.[1] ?? Number.NaN;
      expect(Math.abs(restored - instant), `expiry of ${key} field ${field}`).toBeLessThanOrEqual(
        toleranceMs,
      );
    });
  }
}

function fieldExpiries(value: unknown): readonly (readonly [string, number])[] {
  const expiries = (value as { fieldExpiries?: unknown } | undefined)?.fieldExpiries;
  return Array.isArray(expiries) ? (expiries as [string, number][]) : [];
}

function stripIdle(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripIdle);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([name]) => name !== 'idle')
        .map(([name, inner]) =>
          // Which fields expire is compared exactly; when, within the tolerance.
          name === 'fieldExpiries'
            ? [name, (inner as [string, number][]).map(([field]) => field)]
            : [name, stripIdle(inner)],
        ),
    );
  }
  return value;
}
