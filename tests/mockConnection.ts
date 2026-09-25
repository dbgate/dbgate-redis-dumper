import type {
  RedisCommand,
  RedisConnection,
  RedisPipelineResult,
  RedisReply,
} from '../src/connection/types.js';
import { commandName, toBuffer } from '../src/protocol/arguments.js';

export type Responder = (command: string[]) => RedisReply | Error;

/**
 * A scripted in-memory connection: records every command it is sent, as
 * text, and answers through `respond`. Enough to test the orchestration
 * around the server — ordering, pipelining, error handling, cleanup —
 * without one. Real server behaviour is covered by the integration suites.
 */
export class MockConnection implements RedisConnection {
  readonly sent: string[][] = [];
  readonly pipelines: number[] = [];
  selectedDatabase: number | undefined;

  constructor(
    private readonly respond: Responder,
    options: { selectedDatabase?: number; pipeline?: boolean } = {},
  ) {
    this.selectedDatabase = options.selectedDatabase;
    if (options.pipeline === false) {
      (this as { pipeline?: unknown }).pipeline = undefined;
    }
  }

  private answer(command: RedisCommand): RedisReply {
    const text = command.map(argument => toBuffer(argument).toString('latin1'));
    this.sent.push(text);
    const reply = this.respond(text);
    if (reply instanceof Error) {
      throw reply;
    }
    if (commandName(command) === 'SELECT' && this.selectedDatabase !== undefined) {
      this.selectedDatabase = Number(text[1]);
    }
    return reply;
  }

  async call(command: RedisCommand): Promise<RedisReply> {
    return this.answer(command);
  }

  async pipeline(commands: readonly RedisCommand[]): Promise<readonly RedisPipelineResult[]> {
    this.pipelines.push(commands.length);
    return commands.map(command => {
      try {
        return { ok: true, reply: this.answer(command) };
      } catch (error) {
        return { ok: false, error };
      }
    });
  }
}

export const OK = Buffer.from('OK');

/** An `INFO server` reply for a given version. */
export function infoServer(version: string, extra: Record<string, string> = {}): Buffer {
  const fields = { redis_version: version, redis_mode: 'standalone', ...extra };
  return Buffer.from(
    `# Server\r\n${Object.entries(fields)
      .map(([name, value]) => `${name}:${value}`)
      .join('\r\n')}\r\n`,
  );
}
