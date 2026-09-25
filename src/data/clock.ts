import type { RedisConnection } from '../connection/types.js';
import { replyToArray, replyToInteger } from '../protocol/replies.js';

/**
 * The server's clock, estimated from one `TIME` call.
 *
 * Before Redis 7.0 a key's expiry can only be read relative (`PTTL`), so an
 * absolute instant has to be computed as "server now + remaining". Using the
 * *server's* now rather than the local one keeps clock skew between the
 * dumping machine and the server out of every absolute expiry.
 */
export class ServerClock {
  private constructor(private readonly offsetMs: number) {}

  static async measure(connection: RedisConnection, signal?: AbortSignal): Promise<ServerClock> {
    const before = Date.now();
    const reply = replyToArray(await connection.call(['TIME'], signal));
    const after = Date.now();
    const seconds = replyToInteger(reply[0] ?? null);
    const microseconds = replyToInteger(reply[1] ?? null);
    const serverMs = seconds * 1000 + Math.floor(microseconds / 1000);
    // The reply was generated somewhere between sending and receiving; the
    // midpoint halves the worst-case error.
    return new ServerClock(serverMs - Math.round((before + after) / 2));
  }

  /** A clock that trusts the local time, for tests and servers without `TIME`. */
  static local(): ServerClock {
    return new ServerClock(0);
  }

  /** The server's current time, in Unix milliseconds. */
  now(): number {
    return Date.now() + this.offsetMs;
  }
}
