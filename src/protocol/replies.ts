import type { RedisReply } from '../connection/types.js';
import { RedisDumperError } from '../utils/errors.js';

function unexpected(expected: string, reply: RedisReply): RedisDumperError {
  const shape = reply === null ? 'nil' : Array.isArray(reply) ? 'array' : typeof reply;
  return new RedisDumperError(
    'unexpected-reply',
    `Expected ${expected} reply from the server, got ${shape}`,
  );
}

/** A bulk or status reply as its raw bytes. */
export function replyToBuffer(reply: RedisReply): Buffer {
  if (Buffer.isBuffer(reply)) {
    return reply;
  }
  if (typeof reply === 'string') {
    return Buffer.from(reply, 'utf8');
  }
  if (typeof reply === 'number') {
    return Buffer.from(String(reply), 'latin1');
  }
  throw unexpected('a string', reply);
}

/** A bulk reply as its raw bytes, or `null` for nil. */
export function replyToNullableBuffer(reply: RedisReply): Buffer | null {
  return reply === null ? null : replyToBuffer(reply);
}

/** A status/bulk reply decoded as UTF-8 — only for server-generated text (INFO, TYPE, ids). */
export function replyToString(reply: RedisReply): string {
  return replyToBuffer(reply).toString('utf8');
}

/** An integer reply. Accepts decimal text, since some drivers hand integers over as strings. */
export function replyToInteger(reply: RedisReply): number {
  if (typeof reply === 'number') {
    return reply;
  }
  if (Buffer.isBuffer(reply) || typeof reply === 'string') {
    const text = reply.toString();
    if (/^-?\d+$/.test(text)) {
      return Number(text);
    }
  }
  throw unexpected('an integer', reply);
}

export function replyToArray(reply: RedisReply): readonly RedisReply[] {
  if (Array.isArray(reply)) {
    return reply;
  }
  throw unexpected('an array', reply);
}

/** An array of bulk replies, every element as raw bytes. */
export function replyToBufferArray(reply: RedisReply): Buffer[] {
  return replyToArray(reply).map(replyToBuffer);
}

/**
 * A flat `[name, value, name, value, ...]` reply (XINFO, HELLO, CONFIG GET)
 * as a map keyed by the UTF-8 name.
 */
export function replyToMap(reply: RedisReply): Map<string, RedisReply> {
  const items = replyToArray(reply);
  const map = new Map<string, RedisReply>();
  for (let index = 0; index + 1 < items.length; index += 2) {
    map.set(replyToString(items[index] as RedisReply), items[index + 1] as RedisReply);
  }
  return map;
}
