import type { RedisArgument, RedisCommand } from '../connection/types.js';
import { argumentByteLength } from '../protocol/arguments.js';

/** Receives each command a dump writes, in order. */
export type CommandSink = (command: RedisCommand) => Promise<void>;

/**
 * Batches the elements of one collection into as few commands as the
 * limits allow: a command is flushed once it holds `maxElements` elements
 * or its element bytes reach `maxBytes`, whichever comes first.
 *
 * `build` turns a batch into the command, so commands whose element count
 * appears in the command itself (`HPEXPIREAT key ts FIELDS <n> ...`) are
 * handled the same way as plain variadic ones.
 */
export class CommandChunker {
  private elements: (readonly RedisArgument[])[] = [];
  private bytes = 0;
  private flushedCount = 0;

  constructor(
    private readonly emit: CommandSink,
    private readonly build: (elements: readonly (readonly RedisArgument[])[]) => RedisCommand,
    private readonly maxElements: number,
    private readonly maxBytes: number,
  ) {}

  /** Commands written so far by this chunker. */
  get commandsWritten(): number {
    return this.flushedCount;
  }

  async add(element: readonly RedisArgument[]): Promise<void> {
    this.elements.push(element);
    for (const argument of element) {
      this.bytes += argumentByteLength(argument);
    }
    if (this.elements.length >= this.maxElements || this.bytes >= this.maxBytes) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.elements.length === 0) {
      return;
    }
    const batch = this.elements;
    this.elements = [];
    this.bytes = 0;
    this.flushedCount++;
    await this.emit(this.build(batch));
  }
}

/** `[head..., e1a, e1b, e2a, e2b, ...]` — the shape of every variadic write command. */
export function variadic(
  head: readonly RedisArgument[],
): (elements: readonly (readonly RedisArgument[])[]) => RedisCommand {
  return elements => {
    const command: RedisArgument[] = [...head];
    for (const element of elements) {
      command.push(...element);
    }
    return command;
  };
}
