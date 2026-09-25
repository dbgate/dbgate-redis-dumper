/**
 * Optional adapter for the `ioredis` package.
 *
 * Wraps a caller-owned `ioredis` client as a {@link RedisConnection}. This
 * module is never imported by the core package; `ioredis` is an optional
 * peer dependency and is only resolved when a consumer imports
 * `dbgate-redis-dumper/ioredis` themselves.
 *
 * `ioredis` is the driver DbGate's own Redis plugin uses, which is why it is
 * the bundled adapter.
 */
import type { Redis, RedisOptions } from 'ioredis';
import type {
  AcquiredRedisConnection,
  RedisCommand,
  RedisConnection,
  RedisConnectionSource,
  RedisPipelineResult,
  RedisReply,
  RedisServerErrorInfo,
} from './connection/types.js';
import { commandName, toBuffer } from './protocol/arguments.js';
import {
  errorMessage,
  OperationCancelledError,
  RedisDumperError,
  throwIfAborted,
} from './utils/errors.js';

/** Extracts the error prefix (`WRONGTYPE`, `NOPERM`, ...) from an `ioredis` `ReplyError`. */
export function describeIoredisError(error: unknown): RedisServerErrorInfo | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const prefix = /^([A-Z][A-Z_]+)\s/.exec(error.message)?.[1];
  return prefix ? { prefix, message: error.message } : { message: error.message };
}

function splitCommand(command: RedisCommand): { name: string; args: (string | Buffer | number)[] } {
  const [first, ...rest] = command;
  if (first === undefined) {
    throw new RedisDumperError('empty-command', 'Cannot send an empty command');
  }
  // Arguments go over as Buffers, so a string argument can never be
  // re-encoded along the way, and a numeric-looking one is never reformatted.
  return { name: toBuffer(first).toString('latin1'), args: rest.map(toBuffer) };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new OperationCancelledError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** `ioredis` keeps the database it re-selects after a reconnect here. */
interface IoredisInternals {
  readonly condition?: { select?: number } | null;
  readonly options: RedisOptions;
}

/**
 * Adapts one `ioredis` client as a {@link RedisConnection}.
 *
 * The caller retains ownership: this adapter never disconnects a client it
 * did not create.
 *
 * **Reconnects fail rather than recover.** When `ioredis` loses its socket
 * it reconnects, re-selects the database *it* last recorded, and — by
 * default — resends the commands that were in flight. For a dump that has
 * `SELECT`ed another database, that would read keys from the wrong database
 * with no error at all. So any command whose reply arrives after the
 * socket closed at least once since this adapter was created is rejected
 * with `connection-lost`, and every later command too.
 */
export class IoredisConnectionAdapter implements RedisConnection {
  private closes = 0;
  private database: number;
  private readonly onClose = (): void => {
    this.closes++;
  };

  constructor(private readonly client: Redis) {
    const internals = client as unknown as IoredisInternals;
    this.database = internals.condition?.select ?? internals.options.db ?? 0;
    client.on('close', this.onClose);
  }

  get selectedDatabase(): number {
    return this.database;
  }

  /** Stops listening to the client. The client itself is left untouched. */
  detach(): void {
    this.client.off('close', this.onClose);
  }

  private assertUsable(): void {
    if (this.closes > 0) {
      throw new RedisDumperError(
        'connection-lost',
        'The Redis connection was lost during the operation; ioredis reconnects on its own database, so the operation cannot safely continue',
      );
    }
  }

  private noteSuccess(command: RedisCommand): void {
    if (commandName(command) === 'SELECT' && command[1] !== undefined) {
      this.database = Number(toBuffer(command[1]).toString('latin1'));
    }
  }

  async call(command: RedisCommand, signal?: AbortSignal): Promise<RedisReply> {
    this.assertUsable();
    const { name, args } = splitCommand(command);
    const reply = (await abortable(this.client.callBuffer(name, args), signal)) as RedisReply;
    this.assertUsable();
    this.noteSuccess(command);
    return reply;
  }

  async pipeline(
    commands: readonly RedisCommand[],
    signal?: AbortSignal,
  ): Promise<readonly RedisPipelineResult[]> {
    this.assertUsable();
    const pipeline = this.client.pipeline();
    for (const command of commands) {
      const { name, args } = splitCommand(command);
      pipeline.callBuffer(name, args);
    }
    const replies = (await abortable(pipeline.exec(), signal)) ?? [];
    this.assertUsable();
    return replies.map(([error, reply], index) => {
      if (error) {
        return { ok: false, error };
      }
      this.noteSuccess(commands[index] as RedisCommand);
      return { ok: true, reply: reply as RedisReply };
    });
  }

  describeError(error: unknown): RedisServerErrorInfo | undefined {
    return describeIoredisError(error);
  }
}

/** Borrows a connected `ioredis` client. It is never disconnected by this package. */
export function fromIoredis(client: Redis): IoredisConnectionAdapter {
  return new IoredisConnectionAdapter(client);
}

/**
 * Settings for connections this package creates itself: never queue
 * commands while disconnected, never resend them after a reconnect, never
 * reconnect at all. A dump or restore that loses its connection must fail,
 * not continue on a fresh socket selected to a different database.
 */
const DEDICATED_DEFAULTS: RedisOptions = {
  lazyConnect: true,
  enableOfflineQueue: false,
  autoResendUnfulfilledCommands: false,
  maxRetriesPerRequest: 0,
  retryStrategy: () => null,
};

/**
 * A {@link RedisConnectionSource} that gives every operation its own
 * connection, duplicated from `client` (same host, credentials and
 * database) and closed afterwards.
 *
 * Prefer this over {@link fromIoredis} for a client the application also
 * uses: a dump `SELECT`s other databases, and on a shared client the
 * application's own commands would run against them in the meantime.
 */
export function duplicateIoredis(client: Redis): RedisConnectionSource {
  return {
    async acquire(signal?: AbortSignal): Promise<AcquiredRedisConnection> {
      throwIfAborted(signal);
      const duplicate = client.duplicate(DEDICATED_DEFAULTS);
      await duplicate.connect();
      const adapter = new IoredisConnectionAdapter(duplicate);
      let released = false;
      return {
        connection: adapter,
        dedicated: true,
        async release() {
          if (released) return;
          released = true;
          adapter.detach();
          await duplicate.quit().catch(() => duplicate.disconnect());
        },
      };
    },
  };
}

export interface IoredisConnection {
  readonly connection: IoredisConnectionAdapter;
  readonly client: Redis;
  close(): Promise<void>;
}

/**
 * Opens a new, dedicated `ioredis` connection. `options` are passed to
 * `ioredis` over the dedicated-connection defaults (no offline queue, no
 * reconnect), so any of them can be overridden.
 */
export async function connectIoredis(options: RedisOptions | string): Promise<IoredisConnection> {
  const { Redis: IORedis } = await import('ioredis');
  const client =
    typeof options === 'string'
      ? new IORedis(options, DEDICATED_DEFAULTS)
      : new IORedis({ ...DEDICATED_DEFAULTS, ...options });
  try {
    await client.connect();
  } catch (error) {
    client.disconnect();
    throw new RedisDumperError('connect-failed', errorMessage(error), { cause: error });
  }
  const connection = new IoredisConnectionAdapter(client);
  return {
    connection,
    client,
    async close() {
      connection.detach();
      await client.quit().catch(() => client.disconnect());
    },
  };
}
