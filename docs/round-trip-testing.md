# Round-trip testing

## Running

```sh
npm run docker:up          # Redis 6.2, 7.2, 7.4, 8.0 and Valkey 8.0 on ports 36362–36390
npm run test:integration
npm run docker:down
```

| Variable                | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `REDIS_TEST_TARGETS`    | Comma-separated ids: `redis62,redis72,redis74,redis80,valkey80,host`   |
| `REDIS_TEST_REQUIRED=1` | An unreachable server fails the run instead of skipping (CI sets this) |
| `REDIS_TEST_HOST`       | Host of the servers (default `127.0.0.1`)                              |
| `REDIS_TEST_PASSWORD`   | Password, if the servers need one                                      |
| `REDIS_TEST_HOST_PORT`  | Port of the `host` target, a server you run yourself (default 6379)    |
| `REDIS_TEST_HOST_CLI`   | `redis-cli` binary for the `host` target (default `redis-cli`)         |

For the Docker targets, the native `redis-cli` (`valkey-cli`) runs inside the server's own
container via `docker exec`, so the client always matches the server version. For
`host`, the one on your `PATH` is used. The tests use logical databases 1–6 and flush
them; never point them at a server holding data you care about.

## The fixture

`integration/fixture/data.ts` builds the source database with raw commands, never through
the restore path under test, so a parser bug cannot corrupt the fixture and hide itself.
It covers every core type in each of its internal encodings (listpack, intset, hashtable,
skiplist — each has its own `DUMP` path), and the values most likely to break an encoder:

- every byte value in keys, fields, members and values; the empty key and empty values;
- keys containing spaces, quotes, newlines, a RESP header, and a key named `quit`;
- a 3 MB string and 1000-element collections, above the chunking thresholds;
- scores `inf`, `-inf`, `-0`, `5e-324`, `1.7976931348623157e308`, ties, and a geo set;
- streams with deleted entries, all entries deleted, never an entry, groups, consumers,
  an idle consumer, and pending entries with custom delivery counts;
- key expiries, and per-field hash expiries where the server supports them.

## The comparison

`integration/helpers/snapshot.ts` reads a database back with plain commands into a
canonical, hex-encoded model and compares source and target with `toEqual`. Timing
values — key expiries, field expiries, pending entries' idle times — are compared within
a tolerance, since they are relative to when each side was read.

A negative control dumps with three lossy options (`expiration: 'none'`,
`streamGroups: false`, an `exclude` filter) and asserts the comparison _fails_ for each —
proof that a green round trip means something.

## The matrix

For each server: `text` and `resp` into this library's restore; `text` into
`redis-cli <`, `resp` into `redis-cli --pipe`; the `payload` strategy both ways; tiny
batch sizes (every chunking path); `relative` expiration. The behaviour suite adds
multi-database dumps and mappings, selection and glob parity with `SCAN MATCH`, the
hand-written `redis-cli` script parity test, the allow-list and error handling,
transaction cleanup, cancellation, PEL delivery times, module types (Redis 8 vector
sets), cross-version restores and preflight against an older server.
