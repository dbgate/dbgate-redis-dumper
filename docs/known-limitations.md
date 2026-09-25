# Known limitations

## A dump of a live server is not a point-in-time snapshot

Redis gives a client nothing like a transaction snapshot to read from: `BGSAVE` snapshots
into a file on the server, not over the connection. A dump of a server that is taking
writes reads different keys at different moments. Each key is internally consistent or
reported (`key-changed-during-dump`), but two keys may reflect different instants, and a
large key streamed in chunks can reflect writes that happened while it was read — a list
that is pushed to while `LRANGE` windows are read, for example.

When that matters, dump from a replica (optionally with replication paused), or during a
write pause. `SCAN` itself guarantees every key that exists for the whole dump is seen;
keys created or deleted during it may or may not be.

## Cluster and Sentinel

A cluster node is refused (`cluster-unsupported`): a cluster has no logical databases,
and its keys are spread over nodes. Dump each primary separately through a connection to
that node. A Sentinel holds no data (`sentinel-unsupported`); connect to the primary it
reports.

## RDB files

This package neither reads nor writes `.rdb` files. It produces command scripts, which is
what makes the output restorable with `redis-cli`, diffable, and portable across versions
and between Redis and Valkey. `strategy: 'payload'` uses RDB fragments per key, with the
version caveats in [supported-data-types.md](supported-data-types.md).

## Restores are not atomic

A collection is rebuilt with several commands (`DEL`, then batches of `HSET`), so a reader
of the target can see a key half-restored. Restoring into a database nothing else reads,
then switching (`SWAPDB` or changing the application's database), avoids that.

## Module types need their module

Module-typed keys are written as `RESTORE` payloads; the target must have the same module
loaded. There is no command-level rebuild for RedisJSON, RedisBloom, RedisTimeSeries or
vector sets.

## What cannot be restored by any command

- Stream consumers' `seen-time`/`active-time` (they restart at restore).
- A pending entry whose message was deleted from the stream.
- Key access metadata (LRU idle time, LFU frequency): neither strategy dumps it, and
  restored keys start fresh.
- ACL users, configuration, scripts and functions (`FUNCTION DUMP` is not included): they
  are server state, not data.

## Memory

- `deduplicateKeys` (default on) keeps every exported key in a `Set`. Turn it off for
  databases with hundreds of millions of keys; with `replace` on, a key `SCAN` returns
  twice is still restored correctly, just written twice.
- Small keys are prefetched a page at a time, so memory is bounded by roughly
  `scanCount × batchSize × element size`. Lower either for very large elements.
- `strategy: 'payload'` fetches a page of payloads at once, so a page of very large keys
  is held in memory together; lower `scanCount` for those.
