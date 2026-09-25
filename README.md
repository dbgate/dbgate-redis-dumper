# dbgate-redis-dumper

Standalone, client-agnostic Redis and Valkey dump and restore library for Node.js.

Dumps a server's keys as a script of ordinary Redis commands and restores it back —
entirely over a Redis connection. **No `redis-cli`, no `redis-server`, no RDB tooling, no
external process is ever invoked.** Framework-independent: it does not depend on DbGate
internals and works outside DbGate.

- Node.js >= 20, ESM and CJS builds, full TypeScript types
- `ioredis` is an **optional** peer dependency, reachable only through the separate
  `dbgate-redis-dumper/ioredis` entry point — the core never imports a driver
- Binary-safe end to end: keys and values are bytes, never decoded strings
- Streaming both ways: a dump holds one `SCAN` page at a time and streams large keys in
  chunks, and a restore parses incrementally, so neither ever loads a whole database or
  a whole file (see [memory](docs/known-limitations.md#memory))

## Two formats, both native

A dump is a list of commands (`SET`, `HSET`, `RPUSH`, `SADD`, `ZADD`, `XADD`, ...). It is
written in one of two encodings, and **both restore with the stock `redis-cli`**:

| Format           | Restore natively with          | Why you'd pick it                                   |
| ---------------- | ------------------------------ | --------------------------------------------------- |
| `text` (default) | `redis-cli < dump.redis`       | One command per line; readable, diffable, greppable |
| `resp`           | `redis-cli --pipe < dump.resp` | Redis's own mass-insertion path; much faster        |

There is no custom container, no archive wrapper, and no metadata sidecar. The other way
round works too: **any `redis-cli` script or RESP mass-insertion file restores with this
library**, parsed with a byte-exact port of the grammar `redis-cli` itself uses.

Every path is **proven by automated tests against real Redis 6.2, 7.2, 7.4, 8.0 and Valkey
8.0**, not assumed. Each one ends by reading the restored database back and deep-comparing
every key, value, expiry, hash-field expiry, stream entry, consumer group and pending entry
against the source — and a negative control proves the comparison catches a lossy dump.

| Path                                           | Tested                                 |
| ---------------------------------------------- | -------------------------------------- |
| this library (`text`) → `redis-cli < dump`     | ✅ 6.2, 7.2, 7.4, 8.0, Valkey 8.0      |
| this library (`resp`) → `redis-cli --pipe`     | ✅ 6.2, 7.2, 7.4, 8.0, Valkey 8.0      |
| this library → this library (both formats)     | ✅ 6.2, 7.2, 7.4, 8.0, Valkey 8.0      |
| hand-written `redis-cli` script → this library | ✅ compared against `redis-cli` itself |
| Redis 6.2 dump → Redis 8.0 and Valkey 8.0      | ✅                                     |

See [docs/native-compatibility.md](docs/native-compatibility.md).

## Install

```sh
npm install dbgate-redis-dumper
# optional, for the bundled ioredis adapter:
npm install ioredis
```

## Quick start

### Dump

```ts
import { createWriteStream } from 'node:fs';
import { dumpRedis } from 'dbgate-redis-dumper';
import { connectIoredis } from 'dbgate-redis-dumper/ioredis';

const { connection, close } = await connectIoredis({ host: 'localhost', port: 6379 });

try {
  const result = await dumpRedis(
    connection,
    { databases: 'all' },
    createWriteStream('backup.redis'),
    event => console.log(event.phase, event.database ?? '', event.totalKeysExported ?? ''),
  );

  console.log(`${result.keysExported} keys in ${result.commandsWritten} commands`);
  for (const warning of result.warnings) {
    console.warn(`[${warning.severity}] ${warning.code}: ${warning.message}`);
  }
} finally {
  await close();
}
```

The result is restorable by `redis-cli < backup.redis`.

### Restore

```ts
import { createReadStream } from 'node:fs';
import { restoreRedisDump } from 'dbgate-redis-dumper';

const result = await restoreRedisDump({
  connection,
  source: createReadStream('backup.redis'),
  options: { databaseMapping: { 0: 5 } }, // what was database 0 goes into database 5
  progress: event => console.log(event.phase, event.commandsProcessed),
});

console.log(`${result.commandsExecuted} commands`);
for (const error of result.errors) {
  console.error(`command ${error.commandIndex} (line ${error.location.line}): ${error.message}`);
  console.error(`  ${error.commandPreview}`); // truncated, credential-redacted
}
```

`source` accepts a `string`, a `Buffer`, a `Readable`, or any (async) iterable of text or
`Buffer` chunks. The format is detected from the first byte.

### Using an existing client

```ts
import Redis from 'ioredis';
import { duplicateIoredis, fromIoredis } from 'dbgate-redis-dumper/ioredis';

const client = new Redis(config);
const source = duplicateIoredis(client); // a fresh connection per operation (recommended)
const borrowed = fromIoredis(client); // this very connection, never closed by the library
```

A dump `SELECT`s every database it reads, so on a client your application also uses, its
own commands would run against those databases meanwhile — hence `duplicateIoredis`.
Either way the connection is put back on the database it had selected. See
[docs/ioredis-adapter.md](docs/ioredis-adapter.md).

## Public API

| Function                                                                 | Purpose                                                    |
| ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `dumpRedis(connection, options, output, onProgress?, signal?)`           | Full pipeline: version → scan → pipelined reads → commands |
| `restoreRedisDump({ connection, source, options?, progress?, signal? })` | Streaming parser → allow-list → pipelined execution        |
| `analyzeRedisDump(source)`                                               | What a dump contains and needs, without executing anything |
| `preflightRestore({ connection, requirements })`                         | What a target server lacks, before anything is written     |
| `isRedisDump(sample)` / `detectDumpFormat(sample)`                       | Recognize a dump and its encoding from its first bytes     |
| `parseRedisCommands(input)` / `streamRedisCommands(source)`              | The parser, usable on its own                              |
| `encodeCommand(command, format)`                                         | The encoders, usable on its own                            |
| `checkTargetCompatibility(requirements, server)`                         | Pure version check against a dump's requirements           |
| `fromIoredis` / `duplicateIoredis` / `connectIoredis`                    | Adapter (from `dbgate-redis-dumper/ioredis`)               |

## Fidelity highlights

- **Every core type, and everything around it**: strings, hashes, lists, sets, sorted
  sets and streams — including stream consumer groups, their consumers, each group's
  pending entries (with delivery count and delivery time), `entries-read`, and the
  stream's last ID and counters even when entries were deleted.
- **Expiries are exact.** Written as absolute `PEXPIREAT` instants (what an RDB file
  stores), read with `PEXPIRETIME` where available and from the _server's_ clock
  otherwise. `relative` and `none` modes are available.
- **Per-field hash expiration** (Redis 7.4+, Valkey 9.0+) is preserved.
- **Scores are never parsed.** A sorted-set score is written as the server's own text,
  so `inf`, `-inf`, `5e-324` and 17-digit doubles survive exactly.
- **Module types** (RedisJSON, RedisBloom, Redis 8 vector sets) are written as `RESTORE`
  payloads, with a warning — never silently dropped. `strategy: 'payload'` writes every
  key that way, for exactness down to the internal encoding.
- **Large keys are streamed.** A collection above `batchSize` elements is read in chunks
  (`HSCAN`, `LRANGE` windows, ...), a string above `maxCommandBytes` with `GETRANGE` and
  written as `SET` + `APPEND`, so no single key must fit in memory.
- **Restores are safe by default.** Only data commands run; a dump cannot `FLUSHALL`,
  `CONFIG SET`, `EVAL` or `REPLICAOF` unless you opt in. Error previews redact
  credentials. The connection is handed back on its original database, outside any
  transaction, even when a restore fails or is cancelled.
- **Preflight before you write.** Every dump records which server features it depends
  on; `preflightRestore` tells you what an older target lacks before a single key lands.

## Documentation

| Document                                                     | Contents                                                          |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| [docs/native-compatibility.md](docs/native-compatibility.md) | The two formats, `redis-cli` interoperability, what is reproduced |
| [docs/dump-api.md](docs/dump-api.md)                         | `dumpRedis` options, databases, selection, strategies, progress   |
| [docs/restore-api.md](docs/restore-api.md)                   | `restoreRedisDump`, the parser, allow-list, errors, preflight     |
| [docs/ioredis-adapter.md](docs/ioredis-adapter.md)           | Connection ownership, reconnects, writing another adapter         |
| [docs/supported-data-types.md](docs/supported-data-types.md) | Per-type commands, fidelity and chunking                          |
| [docs/known-limitations.md](docs/known-limitations.md)       | What this package does not do, and why                            |
| [docs/round-trip-testing.md](docs/round-trip-testing.md)     | Running the Docker-backed matrix; the fixture                     |
| [docs/architecture.md](docs/architecture.md)                 | Layer-by-layer design and the reasoning behind it                 |

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test                          # unit tests, no Docker or network needed

npm run docker:up                 # Redis 6.2, 7.2, 7.4, 8.0 + Valkey 8.0
npm run test:integration          # round trips, redis-cli interop, behaviour, cross-version
npm run docker:down

npm run test:package              # builds, then smoke-tests dist/ as ESM and CJS
```

Integration tests skip themselves with a clear message when no server is reachable; set
`REDIS_TEST_REQUIRED=1` (as CI does) to make that a hard error. `REDIS_TEST_TARGETS=redis74`
runs one version while iterating, and `REDIS_TEST_TARGETS=host REDIS_TEST_HOST_PORT=6379`
runs against a server you started yourself.

## License

GPL-3.0-only. See [LICENSE](LICENSE).
