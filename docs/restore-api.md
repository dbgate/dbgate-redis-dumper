# Restore API

```ts
restoreRedisDump({
  connection: RedisConnectionInput,
  source: RedisDumpSource,           // string | Buffer | Readable | (async) iterable of chunks
  options?: RestoreOptions,
  progress?: RestoreProgressCallback,
  signal?: AbortSignal,
}): Promise<RedisDumpRestoreResult>
```

The source is parsed incrementally and executed in pipelines, so a dump of any size
restores in memory bounded by its largest single command.

## Options

| Option                | Default     | Meaning                                                                    |
| --------------------- | ----------- | -------------------------------------------------------------------------- |
| `format`              | `'auto'`    | `'auto'` (by first byte: `*` is RESP), `'text'` or `'resp'`                |
| `stopOnError`         | `true`      | Stop at the first failing command                                          |
| `database`            | —           | `SELECT` this database before the first command                            |
| `databaseMapping`     | —           | `{ 0: 5 }` or `(db) => db + 8`: rewrites every `SELECT` in the dump        |
| `allowedCommands`     | `'restore'` | `'restore'` (data commands), `'any'`, or an explicit list of command names |
| `pipelineSize`        | `64`        | Commands per pipeline; `1` for strictly sequential execution               |
| `restoreSessionState` | `true`      | Put back the original database; `DISCARD` a transaction left open          |
| `maxCommandBytes`     | `1 GiB`     | Refuse (rather than buffer) any single command above this size             |

### Pipelining and `stopOnError`

Commands are sent 64 at a time, which is what makes a restore fast. The cost: with
`stopOnError`, a failure stops the restore _after the pipeline it was part of_, so up to
63 later commands have already run. Set `pipelineSize: 1` when that matters.

### The allow-list

A dump file is input from outside the program, and a Redis script can do far more than
insert data. By default only the commands in `RESTORE_COMMANDS` run — writes for every
type, expiry commands, `RESTORE`, `SELECT`, `MULTI`/`EXEC`, `ECHO`, `PING`, and the data
subcommands of `XGROUP`. Everything else (`FLUSHALL`, `CONFIG`, `EVAL`, `FUNCTION`,
`MODULE`, `REPLICAOF`, `SHUTDOWN`, `ACL`, ...) is refused _without being sent_, reported
as an error of kind `'refused'`, and respects `stopOnError`. `analyzeRedisDump` lists
what a default restore would refuse before you run it.

## Result

```ts
interface RedisDumpRestoreResult {
  commandsExecuted: number;
  commandsFailed: number;
  bytesConsumed: number;
  format: 'text' | 'resp';
  databases: number[]; // target databases selected, in order
  errors: RestoreCommandError[];
  warnings: RestoreWarning[];
  cancelled: boolean;
}

interface RestoreCommandError {
  commandIndex: number;
  location: { offset: number; line?: number };
  commandPreview: string; // truncated, credential-redacted
  message: string;
  kind: 'parse' | 'refused' | 'server';
  serverError?: { prefix?: string; message: string }; // prefix: WRONGTYPE, OOM, NOPERM, ...
}
```

Warnings: `missing-final-newline` (the last text line had no newline — `redis-cli` runs it
anyway, and so does this, but it is also what a truncated file looks like),
`transaction-discarded`, `selected-database-unknown`.

A malformed RESP stream, or a command above `maxCommandBytes`, rejects with a
`RedisDumpParseError` carrying the `location`.

## The parser

`parseRedisCommands(input)`, `streamRedisCommands(source)` and the push-based
`CommandParser` are exported on their own. The text grammar is a byte-exact port of
`sdssplitargs()`, the function `redis-cli` splits each line with, and follows
`redis-cli`'s script conventions:

- blank lines are skipped; `\r\n` line endings work;
- `quit` or `exit` on a line of its own ends the script;
- a leading count repeats the command: `3 INCR counter`;
- a line with invalid quoting is an error — thrown by `parseRedisCommands`, and reported
  (kind `'parse'`) and skipped by `restoreRedisDump`, as `redis-cli` prints
  "Invalid argument(s)" and moves on.

The RESP mode follows the server's request parser: arrays of bulk strings, and inline
commands for lines that do not start with `*`.

Parser output is asserted identical at every single split point of the input, and when
fed one byte at a time.

## Inspection and preflight

```ts
const analysis = await analyzeRedisDump(createReadStream('backup.redis'));
// { format, commands, bytes, commandCounts, refusedByDefault, requirements }

const preflight = await preflightRestore({ connection, requirements: analysis.requirements });
// { server, compatible, issues: [{ feature, status, message }], nonEmptyDatabases }
```

`requirements` is also on every `DumpResult`, so a preflight needs no second pass over a
dump you just wrote. Issues have status `'unsupported'` (the target certainly rejects it)
or `'unverified'` (a `RESTORE` payload whose RDB version this package cannot map to the
target's). `nonEmptyDatabases` lists the target databases the dump would write into that
already hold keys: a restore replaces keys of the same name and leaves the rest.

`isRedisDump(sample)` recognizes a dump from its first few kilobytes; `detectDumpFormat`
tells the two encodings apart.
