import type { RedisArgument, RedisCommand } from '../../src/connection/types.js';
import type { RedisServerCapabilities } from '../../src/version/types.js';

/** Every byte value once, the hardest possible payload for a text encoding. */
export const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, index) => index));

/** Sizes chosen to cross the default chunking thresholds (128 elements, 1 MiB). */
export const LARGE_ELEMENTS = 1_000;
export const LARGE_STRING_BYTES = 3 * 1024 * 1024 + 17;

/** A deterministic pseudo-random byte string, so large values are not trivially compressible. */
export function noise(length: number, seed: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  let state = seed >>> 0 || 1;
  for (let index = 0; index < length; index++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    out[index] = state & 0xff;
  }
  return out;
}

const HOUR = 3_600_000;

/**
 * Commands that build the round-trip fixture: every core type, in every
 * internal encoding Redis picks for it (listpack/intset/hashtable/skiplist
 * — each has its own code path in `DUMP`), with the key names and values
 * most likely to break an encoder.
 *
 * Written as raw commands and run by `run()`, never through the restore
 * path under test.
 */
export function fixtureCommands(
  capabilities: RedisServerCapabilities,
  now: number,
): RedisCommand[] {
  const commands: RedisCommand[] = [];
  const add = (...command: RedisArgument[]): void => {
    commands.push(command);
  };

  // --- strings -----------------------------------------------------------
  add('SET', 'string:ascii', 'hello world');
  add('SET', 'string:utf8', 'Příliš žluťoučký kůň úpěl ďábelské ódy — 日本語 🎉');
  add('SET', 'string:binary', ALL_BYTES);
  add('SET', 'string:empty', '');
  add('SET', 'string:int', '9223372036854775807');
  add('SET', 'string:quotes', `it's "quoted" \\ back\\slash`);
  add('SET', 'string:newlines', 'line1\nline2\r\nline3\ttab');
  add('SET', 'string:large', noise(LARGE_STRING_BYTES, 1));
  add('SET', 'string:ttl', 'expires', 'PX', 5 * HOUR);
  add('SET', 'string:ttl-absolute', 'expires', 'PXAT', now + 7 * HOUR);
  add('SETBIT', 'string:bitmap', 100_000, 1);
  add('PFADD', 'string:hll', 'a', 'b', 'c', 'd');

  // --- awkward key names -------------------------------------------------
  add('SET', '', 'the empty key');
  add('SET', 'key with spaces', '1');
  add('SET', 'key"with"quotes', '2');
  add('SET', "key'with'apostrophes", '3');
  add('SET', 'key\nwith\nnewlines', '4');
  add('SET', Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x22, 0x5c]), '5');
  add('SET', '*3\r\n$3\r\nSET', 'looks like RESP');
  add('SET', 'quit', 'a key named like a redis-cli command');

  // --- hashes --------------------------------------------------------------
  add('HSET', 'hash:small', 'a', '1', 'b', '2', 'empty', '');
  add('HSET', 'hash:binary', ALL_BYTES, ALL_BYTES, 'x', noise(300, 2));
  const bigHash: RedisArgument[] = ['HSET', 'hash:large'];
  for (let index = 0; index < LARGE_ELEMENTS; index++) {
    bigHash.push(`field:${index}`, `value:${index}`);
  }
  add(...bigHash);
  add('HSET', 'hash:ttl', 'f', 'v');
  add('PEXPIRE', 'hash:ttl', 3 * HOUR);
  if (capabilities.hashFieldExpiration) {
    add('HSET', 'hash:field-ttl', 'keep', '1', 'soon', '2', 'later', '3', 'same', '4');
    add('HPEXPIREAT', 'hash:field-ttl', now + 2 * HOUR, 'FIELDS', 2, 'soon', 'same');
    add('HPEXPIREAT', 'hash:field-ttl', now + 9 * HOUR, 'FIELDS', 1, 'later');
    add(
      'HPEXPIREAT',
      'hash:large',
      now + 4 * HOUR,
      'FIELDS',
      3,
      'field:1',
      'field:500',
      'field:999',
    );
  }

  // --- lists ---------------------------------------------------------------
  add('RPUSH', 'list:small', 'a', 'b', 'a', '', 'c');
  add('RPUSH', 'list:binary', ALL_BYTES, noise(1000, 3));
  const bigList: RedisArgument[] = ['RPUSH', 'list:large'];
  for (let index = 0; index < LARGE_ELEMENTS * 3; index++) {
    bigList.push(`item:${index % 17}`);
  }
  add(...bigList);

  // --- sets ------------------------------------------------------------------
  add('SADD', 'set:intset', '1', '2', '3', '-9223372036854775808');
  add('SADD', 'set:strings', 'x', 'y', '', ALL_BYTES);
  const bigSet: RedisArgument[] = ['SADD', 'set:large'];
  for (let index = 0; index < LARGE_ELEMENTS; index++) {
    bigSet.push(`member:${index}`);
  }
  add(...bigSet);

  // --- sorted sets -----------------------------------------------------------
  add(
    'ZADD',
    'zset:scores',
    'inf',
    'plus-infinity',
    '-inf',
    'minus-infinity',
    '0.1',
    'one-tenth',
    '1.7976931348623157e308',
    'max-double',
    '5e-324',
    'min-subnormal',
    '-0',
    'negative-zero',
    '3',
    'tie-b',
    '3',
    'tie-a',
  );
  add('ZADD', 'zset:binary', '1', ALL_BYTES);
  const bigZset: RedisArgument[] = ['ZADD', 'zset:large'];
  for (let index = 0; index < LARGE_ELEMENTS; index++) {
    bigZset.push(String(index / 7), `member:${index}`);
  }
  add(...bigZset);
  add('GEOADD', 'zset:geo', '14.4378', '50.0755', 'Prague', '-0.1276', '51.5072', 'London');

  // --- streams -----------------------------------------------------------------
  add('XADD', 'stream:plain', '1-1', 'field', 'value', 'n', '1');
  add('XADD', 'stream:plain', '1-2', 'binary', ALL_BYTES);
  add('XADD', 'stream:plain', '5-0', 'x', '');
  for (let index = 0; index < 300; index++) {
    add('XADD', 'stream:long', `${1000 + index}-0`, 'i', String(index));
  }
  // Deleted entries: the last id and (7.0+) counters must survive.
  add('XADD', 'stream:gaps', '10-0', 'a', '1');
  add('XADD', 'stream:gaps', '20-0', 'a', '2');
  add('XADD', 'stream:gaps', '30-0', 'a', '3');
  add('XDEL', 'stream:gaps', '30-0');
  add('XDEL', 'stream:gaps', '10-0');
  // Every entry deleted: an empty stream with a non-zero last id.
  add('XADD', 'stream:emptied', '42-7', 'a', '1');
  add('XDEL', 'stream:emptied', '42-7');
  // Never held an entry.
  add('XGROUP', 'CREATE', 'stream:never', 'g', '$', 'MKSTREAM');
  add('XGROUP', 'DESTROY', 'stream:never', 'g');
  // Consumer groups with consumers and pending entries.
  add('XADD', 'stream:groups', '1-0', 'job', 'a');
  add('XADD', 'stream:groups', '2-0', 'job', 'b');
  add('XADD', 'stream:groups', '3-0', 'job', 'c');
  add('XADD', 'stream:groups', '4-0', 'job', 'd');
  add('XGROUP', 'CREATE', 'stream:groups', 'workers', '0');
  add('XGROUP', 'CREATE', 'stream:groups', 'late', '$');
  add('XREADGROUP', 'GROUP', 'workers', 'alice', 'COUNT', '2', 'STREAMS', 'stream:groups', '>');
  add('XREADGROUP', 'GROUP', 'workers', 'bob', 'COUNT', '1', 'STREAMS', 'stream:groups', '>');
  add('XACK', 'stream:groups', 'workers', '1-0');
  add('XCLAIM', 'stream:groups', 'workers', 'bob', '0', '2-0', 'RETRYCOUNT', '5', 'JUSTID');
  if (capabilities.xgroupCreateConsumer) {
    add('XGROUP', 'CREATECONSUMER', 'stream:groups', 'workers', 'idle-carol');
  }
  add('PEXPIRE', 'stream:groups', 6 * HOUR);

  return commands;
}
