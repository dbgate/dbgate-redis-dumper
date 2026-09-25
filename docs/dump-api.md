# Dump API

```ts
dumpRedis(
  connection: RedisConnectionInput,
  options: DumpRedisOptions,
  output: Writable | DumpWriter,
  onProgress?: DumpProgressCallback,
  signal?: AbortSignal,
): Promise<DumpResult>
```

`output` is a Node `Writable` (backpressure is honoured, and the stream is never ended —
the caller owns it) or any `DumpWriter`. `BufferDumpWriter` collects into memory for
tests and previews.

## Options

| Option                | Default      | Meaning                                                                         |
| --------------------- | ------------ | ------------------------------------------------------------------------------- |
| `format`              | `'text'`     | `'text'` (`redis-cli < dump`) or `'resp'` (`redis-cli --pipe < dump`)           |
| `databases`           | `'current'`  | `'current'`, `'all'`, or `[0, 3, ...]` — see below                              |
| `selection`           | everything   | `match`, `include`, `exclude`, `types`, `keys` — see below                      |
| `strategy`            | `'commands'` | `'commands'` rebuilds keys with commands; `'payload'` writes `RESTORE` payloads |
| `unknownTypes`        | `'payload'`  | Module types: `'payload'` (with a warning) or `'skip'` (with a warning)         |
| `expiration`          | `'absolute'` | `'absolute'` (`PEXPIREAT`), `'relative'` (`PEXPIRE`), `'none'`                  |
| `replace`             | `true`       | `DEL` before rebuilding a collection; `RESTORE ... REPLACE`                     |
| `batchSize`           | `128`        | Elements per read and per written command                                       |
| `maxCommandBytes`     | `1 MiB`      | Flush a command at this size; strings above it are streamed with `GETRANGE`     |
| `scanCount`           | `1000`       | `SCAN ... COUNT` hint, and the unit of pipelining                               |
| `hashFieldExpiration` | `true`       | Write per-field hash expirations (Redis 7.4+, Valkey 9.0+)                      |
| `streamGroups`        | `true`       | Write consumer groups, consumers and pending entries                            |
| `deduplicateKeys`     | `true`       | Drop keys `SCAN` returns twice (costs memory proportional to the key count)     |
| `header`              | `false`      | Start with an `ECHO` naming producer, source and time                           |
| `text.escapeNonAscii` | `false`      | In `text`, escape valid UTF-8 as `\xHH` too                                     |

### Databases

- `'current'` dumps the database the connection has selected and writes **no `SELECT`**,
  so the dump restores into whichever database the restoring client uses — like a
  single-database `mysqldump` without `USE`.
- `'all'` dumps every database `INFO keyspace` reports as non-empty; an array dumps the
  listed ones. Each is introduced by `SELECT n`.

The connection is `SELECT`ed through each database to read it, and put back on the one it
started on afterwards — even when the dump fails or is cancelled. When the adapter cannot
say which database that was and the server is older than 6.2 (no `CLIENT INFO`), the dump
warns with `selected-database-unknown`.

### Selection

```ts
selection: {
  match: 'session:*',          // pushed down to SCAN ... MATCH: filtered on the server
  include: ['session:eu:*'],   // client-side: must match at least one
  exclude: ['session:*:tmp'],  // client-side: must match none
  types: ['hash'],             // one type is pushed down to SCAN ... TYPE (Redis 6.0+)
  keys: ['a', 'b'],            // an explicit list, dumped without SCAN
}
```

Client-side patterns use a port of Redis's own `stringmatchlen()`, and an integration test
checks it against the server's `SCAN MATCH` pattern by pattern, so a pattern selects the
same keys wherever it is applied.

## Result

```ts
interface DumpResult {
  bytesWritten: number;
  commandsWritten: number;
  keysExported: number;
  keysSkipped: number; // filtered by type, vanished, changed, skipped type
  databases: { database; keysExported; keysSkipped }[];
  warnings: RedisDiagnostic[]; // { severity, code, message, database?, key? }
  cancelled: boolean; // the output is incomplete when true
  requirements: DumpRequirements; // pass to preflightRestore
  server: RedisServerVersion;
}
```

Repeated informational diagnostics (`key-vanished`, `stream-consumer-activity-reset`,
...) are reported once with an occurrence count, so a condition affecting a million keys
does not produce a million entries.

| Code                             | Severity | Meaning                                                  |
| -------------------------------- | -------- | -------------------------------------------------------- |
| `key-vanished`                   | info     | Deleted or expired while being read; not in the dump     |
| `key-changed-during-dump`        | warning  | Type or length changed while being read; not in the dump |
| `module-type-as-payload`         | warning  | Module type written as a `RESTORE` payload               |
| `unsupported-key-type`           | warning  | Module type skipped (`unknownTypes: 'skip'`)             |
| `stream-consumer-activity-reset` | info     | Consumer seen/active times cannot be restored            |
| `selected-database-unknown`      | warning  | The original database could not be determined            |

Errors that make a dump impossible are thrown as `RedisDumperError` with a `code`:
`cluster-unsupported`, `sentinel-unsupported`, `unsupported-version` (older than 5.0).

## Progress

`onProgress` receives `{ phase, database?, keysExported?, keysEstimated?,
totalKeysExported?, commandsWritten?, bytesWritten?, keyName? }` with phases `connecting`,
`detecting-version`, `scanning` (per database, with the server's key count as
`keysEstimated`), `exporting-keys` (per page, and before each large key with its
`keyName`) and `finalizing`.

## Cancellation

Abort the `signal`: the dump stops at the next page or chunk and resolves with
`cancelled: true` and whatever was written so far. An already-aborted signal rejects with
`OperationCancelledError` before anything is sent.

## Lower-level pieces

`scanKeys()` (the page iterator), `KeyExporter` (one page → commands), `exportStream()`,
`encodeCommand()` and `RequirementTracker` are exported for callers building their own
pipeline — for example to write each database to a separate file.
