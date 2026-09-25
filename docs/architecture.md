# Architecture

The package is a stack of layers, each usable on its own. Nothing above the
`connection` layer knows what driver is in use. It mirrors `dbgate-pg-dumper`,
`dbgate-mssql-dumper` and `dbgate-mysql-dumper` — connection abstraction, planning,
rendering and restore as separate layers — but every layer is redesigned for what Redis
is: a key-value server with no catalog, no schema, and no snapshot a client can read from.

```
                     ┌──────────────────────────────────────────────┐
  api/               │ dumpRedis()                                  │  orchestration
                     └──────────────────────────────────────────────┘
                            │                         │
  scan/  ────────── SCAN pages of keys                │
  data/  ────────── pipelined reads → commands        │         restore/
                     (keyExporter, streamExport)      │           parser (text + RESP) →
  protocol/ ─────── commands → text | RESP bytes      │           allow-list → pipelines
  writer/  ──────── bytes → Writable                  │
                                                      │   preflight/  compatibility/
  version/ selection/ security/ model/ utils/         │
                     ┌──────────────────────────────────────────────┐
  connection/        │ RedisConnection (driver-agnostic)            │
                     └──────────────────────────────────────────────┘
                            │
  ioredis.ts  ─────── the only module that knows ioredis exists
```

## `connection/` — the driver boundary

`RedisConnection` is the whole contract: `call()`, an optional `pipeline()`, an optional
`selectedDatabase`, and an optional `describeError()`. The core never imports a driver,
and `tests/packageBoundaries.test.ts` fails if it starts to.

### Why replies must be `Buffer`s

Redis keys and values are arbitrary bytes. A driver that decodes bulk replies as UTF-8
replaces every invalid sequence with U+FFFD — silently, and irreversibly — so an adapter
must hand back bulk strings as `Buffer`s (`ioredis`'s `callBuffer`). Text is decoded in
exactly one place, `replyToString`, and only for server-generated text: `INFO`, `TYPE`,
cursors, stream IDs.

### Why one physical connection

`SELECT` is connection state. A dump switches the connection between logical databases,
so a client that spreads commands across sockets — or reconnects and re-selects a
database of its own choosing, as `ioredis` does by default — would read keys from the
wrong database with no error at all. The adapter contract therefore requires one socket,
and the bundled adapter fails every command once that socket has closed. See
[ioredis-adapter.md](ioredis-adapter.md).

## `data/` — reading keys without a round trip per command

Exporting one key needs its type, its expiry, its size and its value. On a remote server
each round trip costs far more than the command, so `KeyExporter` reads a `SCAN` page in
stages, each stage **one pipeline across every key in the page**:

1. `TYPE` + `PEXPIRETIME` (or `PTTL` before 7.0) for every key;
2. the size (`STRLEN`, `HLEN`, `LLEN`, `SCARD`, `ZCARD`) of every core-typed key;
3. the full value of every key small enough to fetch in one command (`GET`, `HGETALL`,
   `LRANGE 0 -1`, `SMEMBERS`, `ZRANGE ... WITHSCORES`, `DUMP`), plus `HPEXPIRETIME` for
   small hashes on servers with field expiration.

A page of 1000 keys costs three or four round trips, however many keys it holds. Only
keys too large to hold at once, and streams, are then read individually, in chunks.

### Races are detected, not papered over

Nothing can be made atomic without blocking the server, so a key can change between
stages. Each race is detected where it can be: a key that is gone is reported as
`key-vanished` (info); a key whose type changed, or a large key that changed length or
vanished mid-stream, is reported as `key-changed-during-dump` (warning), and for a
partially written large key a trailing `DEL` is written so the restore never produces a
half-populated key.

### Expiries and the server clock

Before Redis 7.0 an expiry can only be read relative (`PTTL`). The absolute instant is
computed from the **server's** clock, estimated from one `TIME` call at the start, so
clock skew between the dumping machine and the server never leaks into the dump.

## `protocol/` — two encodings of the same commands

`text` is the grammar of `sdssplitargs()`, which is how `redis-cli` reads a script from
stdin: bare tokens, or double-quoted with `\xHH` and the C escapes. Two consequences
shape the format:

- **No comments.** `redis-cli` sends every non-blank line to the server, `#` included, so
  a dump cannot carry a header comment. `header: true` writes an `ECHO` instead — the one
  label both `redis-cli` and this package restore unchanged.
- **Never a raw newline.** `redis-cli` is line-based; every newline in a value is escaped.

`resp` is RESP2 multibulk, byte for byte what a client sends — Redis's documented
mass-insertion format, forwarded unchanged by `redis-cli --pipe`.

## `restore/` — a parser that agrees with `redis-cli`

`CommandParser` is push-based and incremental: chunks may split anywhere, even inside an
argument or a `\r\n`, and memory is bounded by the largest single command. Its text mode
is a byte-exact port of `sdssplitargs()`, including its odd corners (a quote in the middle
of a token switches into quoted mode; a closing quote must be followed by whitespace), and
of `redis-cli`'s script handling: `quit`/`exit` end the script, a leading number repeats
the command, and a line with invalid quoting is reported and skipped as `redis-cli` does.
The RESP mode follows the server's request parser, including inline commands.

`ByteQueue` keeps arriving chunks as they are and only copies when a complete token is
taken, and searches resume where they stopped — so a 500 MB value in 64 KB chunks parses
in linear time. Tests assert identical output at every single split point.

Restore sends commands in pipelines (64 by default), checks each against the allow-list
before sending, rewrites `SELECT` through `databaseMapping`, and in a `finally` puts the
connection back on its original database and `DISCARD`s a transaction the dump left open.

## `compatibility/` — one classifier, used both ways

A dump is written in the richest form the _source_ supports. Rather than guess the target
at dump time, `featuresOfCommand` classifies every command — by the dump as it writes and
by `analyzeRedisDump` when reading a file back — into features with the first release of
Redis and of Valkey that accepts them. `RESTORE` payloads additionally carry their RDB
version, read from the payload trailer. `preflightRestore` compares the result with a
target, and says "unverified" rather than "fine" where the RDB mapping is unknown.
