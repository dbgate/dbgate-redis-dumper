# Native compatibility

"Native" here means `redis-cli`, the client every Redis and Valkey installation ships. The
promise runs both ways, and every part of it is an automated test against real servers
(Redis 6.2, 7.2, 7.4, 8.0 and Valkey 8.0), never an assumption.

## Dumps from this library restore with `redis-cli`

```sh
redis-cli -n 0 < dump.redis         # format: 'text'
redis-cli -n 0 --pipe < dump.resp   # format: 'resp'
```

The round-trip suite restores the full fixture both ways on every server, then reads the
target back and deep-compares it with the source: every key, value, expiry, hash-field
expiry, stream entry, group, consumer and pending entry.

### How the `text` format stays `redis-cli`-safe

`redis-cli` reading stdin splits every line with `sdssplitargs()`. The encoder writes
exactly that grammar and nothing else:

- An argument is bare only when it is printable ASCII without whitespace, quotes or
  backslashes. Anything else is double-quoted, with `\"`, `\\`, `\n`, `\r`, `\t` and
  `\xHH` escapes; valid UTF-8 stays readable (`escapeNonAscii: true` escapes it too).
- No raw newline ever appears inside an argument, so each command is exactly one line.
- No comments, because `redis-cli` would send `#` to the server as a command. The
  `header` option writes an `ECHO` label instead.
- A key named `quit` or `exit` is safe: `redis-cli` only ends the script on a line that
  is _just_ that word, and a key is always preceded by its command.

The encoder is property-tested: 500 random commands, weighted towards quotes,
backslashes, CR/LF, NUL and high bytes, each round-tripped through the `sdssplitargs`
port — in both escaping modes.

### The `resp` format

RESP2 arrays of bulk strings: byte for byte what a client sends a server. `redis-cli
--pipe` forwards it unchanged and reports `errors: 0, replies: N`, which the tests check.

## `redis-cli` scripts restore with this library

Anything `redis-cli` accepts on stdin restores with `restoreRedisDump`, with the same
meaning. The behaviour suite feeds one hand-written script — bare and quoted arguments,
single quotes, a quote switching mode mid-token, odd spacing, a repeat count, an invalid
line, and `quit` followed by more commands — to both `redis-cli` and this library, and
compares the two resulting databases.

| `redis-cli` behaviour                            | This library                                                 |
| ------------------------------------------------ | ------------------------------------------------------------ |
| `sdssplitargs()` quoting and escapes             | Byte-exact port                                              |
| Blank lines skipped, CRLF accepted               | Same                                                         |
| `quit` / `exit` ends the script                  | Same                                                         |
| `3 INCR x` runs `INCR x` three times             | Same                                                         |
| Invalid quoting: "Invalid argument(s)", continue | Error of kind `'parse'`; continues with `stopOnError: false` |
| Last line without newline is still run           | Same, plus a `missing-final-newline` warning                 |
| Any command is sent                              | Only data commands, unless `allowedCommands` says otherwise  |

RESP mass-insertion files (the format documented for `redis-cli --pipe`) are read as the
server reads them, including inline commands between arrays.

## Across versions and between Redis and Valkey

A `commands` dump from Redis 6.2 restores onto Redis 8.0 and onto Valkey 8.0 (tested). The
other direction depends on what the source used: a Redis 7.4 dump with hash-field
expirations cannot restore onto 6.2 or Valkey 8. `preflightRestore` names exactly which
features a target lacks before anything is written (tested against a real 6.2).
