# Supported data types

With the default `strategy: 'commands'`, every key is rebuilt with ordinary commands.
Collections are preceded by `DEL key` (with `replace`, the default); expiries follow as
`PEXPIREAT key <ms>` (or `PEXPIRE` with `expiration: 'relative'`).

| Type   | Written as                                  | Read with (small / large)           | Notes                                                 |
| ------ | ------------------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| string | `SET` (+ `APPEND` chunks)                   | `GET` / `GETRANGE` windows          | Binary-safe; bitmaps and HyperLogLogs are strings too |
| hash   | `HSET` in batches, `HPEXPIREAT ... FIELDS`  | `HGETALL` / `HSCAN`                 | Per-field expiry on Redis 7.4+, Valkey 9.0+           |
| list   | `RPUSH` in batches                          | `LRANGE 0 -1` / `LRANGE` windows    | Order preserved                                       |
| set    | `SADD` in batches                           | `SMEMBERS` / `SSCAN`                |                                                       |
| zset   | `ZADD score member` in batches              | `ZRANGE ... WITHSCORES` / `ZSCAN`   | Scores are the server's own text; geo sets are zsets  |
| stream | `XADD id ...`, `XSETID`, `XGROUP`, `XCLAIM` | `XINFO`, `XRANGE`, `XPENDING` pages | See below                                             |
| module | `RESTORE key ttl <payload> REPLACE ABSTTL`  | `DUMP`                              | RedisJSON, RedisBloom, vector sets; RDB-version bound |

"Small" means at most `batchSize` (128) elements, or `maxCommandBytes` (1 MiB) for
strings; small keys are read in one command, pipelined across a whole `SCAN` page.
Larger ones are streamed in chunks of those sizes, so no key must fit in memory at once.
Duplicates a `*SCAN` may return are harmless: `HSET`, `SADD` and `ZADD` of an element
already present leave the result unchanged.

## Values never pass through JavaScript types

- Keys, fields, members and values are `Buffer`s end to end. The `text` format escapes
  what `redis-cli` needs escaped (`\xHH` for bytes outside printable ASCII, unless the
  whole argument is valid UTF-8) and nothing else.
- Sorted-set scores are copied as the server's text reply and never parsed, so `inf`,
  `-inf`, `-0`, `5e-324` and `1.7976931348623157e308` round-trip exactly.
- Integers, counters and timestamps stay decimal text on the wire.

## Streams

A stream is rebuilt in the order a restore needs:

1. `XADD key <id> field value ...` for every entry, in ID order (explicit IDs are only
   accepted above the current top).
2. For a stream with no entries left: `XADD key MAXLEN 0 <last-id> x ""` recreates it
   empty with the right last ID. For one that never held an entry,
   `XGROUP CREATE ... MKSTREAM` plus `DESTROY` of a placeholder group.
3. `XSETID key <last-generated-id>`, with `ENTRIESADDED` and `MAXDELETEDID` when the
   source has them (Redis 7.0+), so deleted tail entries and counters survive.
4. Per group: `XGROUP CREATE key group <last-delivered-id> [ENTRIESREAD n]`, then
   `XGROUP CREATECONSUMER` for every consumer (Redis 6.2+).
5. Per pending entry: `XCLAIM key group consumer 0 <id> TIME <delivery-ms> RETRYCOUNT <n>
FORCE JUSTID`, which puts the entry back into the group's PEL under its consumer, with
   its delivery count and delivery time (`IDLE` in `relative` mode).

What cannot be restored by any command: a consumer's `seen-time` and `active-time`
(reported once as `stream-consumer-activity-reset`), and a PEL entry whose message was
deleted from the stream (`XCLAIM ... FORCE` ignores IDs that do not exist).

## The `payload` strategy

`strategy: 'payload'` writes every key as `RESTORE` with its `DUMP` payload. That is exact
down to the internal encoding and object metadata, and handles every type including
modules — but the payload is an RDB fragment: a server only accepts payloads of its own
RDB version or older. `DumpResult.requirements.payloadRdbVersion` records the highest
one, and `preflightRestore` checks it against the target:

| RDB version | Written by                  |
| ----------- | --------------------------- |
| 9           | Redis 5.0 – 6.2             |
| 10          | Redis 7.0                   |
| 11          | Redis 7.2, Valkey 7.2 – 8.x |
| 12          | Redis 7.4 – 8.x             |
