# The `ioredis` adapter

`dbgate-redis-dumper/ioredis` is the only module that imports a driver, and it does so
lazily: `ioredis` is an optional peer dependency, and the core package loads without it
(the build smoke test proves this against `dist/`). `ioredis` is the driver DbGate's own
Redis plugin uses.

## Three ways to get a connection

| Function                   | Connection                                 | Closed by the library |
| -------------------------- | ------------------------------------------ | --------------------- |
| `connectIoredis(options)`  | A new dedicated connection                 | by your `close()`     |
| `duplicateIoredis(client)` | A duplicate of `client`, one per operation | yes, after each       |
| `fromIoredis(client)`      | `client` itself, borrowed                  | never                 |

`duplicateIoredis` is the right choice for a client your application also uses. A dump
`SELECT`s every database it reads; on a shared client, the application's own commands
would run against those databases in the meantime.

## Reconnects fail rather than recover

When `ioredis` loses its socket it reconnects, re-selects the database _it_ last recorded,
and by default resends the commands that were in flight. For a dump that has `SELECT`ed
another database, that would silently read keys from the wrong database. So the adapter
fails every command — with `RedisDumperError` code `connection-lost` — once the socket
has closed at least once since the adapter was created.

Connections the library creates (`connectIoredis`, `duplicateIoredis`) are additionally
configured never to queue commands while offline, never to resend, and never to
reconnect. `connectIoredis` lets you override any of these through its options.

## Bytes in, bytes out

Every argument is sent as a `Buffer` and every reply is read with `callBuffer`, so keys
and values never pass through a JavaScript string. The adapter tracks its own `SELECT`s
to report `selectedDatabase`, starting from the client's current database.

## Writing another adapter

Implement `RedisConnection`:

```ts
interface RedisConnection {
  call(command: RedisCommand, signal?: AbortSignal): Promise<RedisReply>;
  pipeline?(
    commands: readonly RedisCommand[],
    signal?: AbortSignal,
  ): Promise<readonly RedisPipelineResult[]>;
  readonly selectedDatabase?: number;
  describeError?(error: unknown): RedisServerErrorInfo | undefined;
}
```

The rules that matter:

- **Bulk replies as `Buffer`s.** Never decoded strings.
- **RESP2 reply shapes.** Arrays for `HGETALL`, `XINFO` and friends, not RESP3 maps.
- **One physical socket, and fail on reconnect** — see above.
- **`pipeline()` is optional but important.** Without it, every key costs several round
  trips; with it, a page of 1000 keys costs three or four. One failing command in a
  pipeline must not affect the others.

`tests/mockConnection.ts` is a minimal example.
