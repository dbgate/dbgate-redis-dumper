import { RedisDumperError } from '../utils/errors.js';
import { ByteQueue } from './byteQueue.js';
import type { RedisDumpSource } from './source.js';
import { readSource } from './source.js';
import { SplitArgsError, splitArgs } from './splitArgs.js';

/**
 * How a dump is encoded. `'auto'` (default) decides from the first
 * non-whitespace byte: `*` means RESP, anything else `redis-cli` text.
 */
export type DumpFormatOption = 'auto' | 'text' | 'resp';

/** Where a command starts in the source. */
export interface CommandLocation {
  /** Byte offset of the command's first byte. */
  readonly offset: number;
  /** 1-based line number (text format and inline RESP commands only). */
  readonly line?: number;
}

export interface ParsedCommand {
  /** Command name and arguments, as raw bytes. */
  readonly argv: readonly Buffer[];
  /** 0-based position in the dump. */
  readonly index: number;
  readonly location: CommandLocation;
  /**
   * Set, with `argv` empty, for a line `redis-cli` itself would reject as
   * "Invalid argument(s)" (unbalanced quotes) — only when the parser runs
   * with `invalidLines: 'report'`.
   */
  readonly invalid?: string;
}

export interface CommandParserOptions {
  readonly format?: DumpFormatOption;
  /**
   * Refuse any single command larger than this many bytes, rather than
   * buffering it. Defaults to 1 GiB, the server's own limit on a client's
   * query buffer (`client-query-buffer-limit`) — a larger command could never
   * be accepted anyway.
   */
  readonly maxCommandBytes?: number;
  /**
   * What to do with a text line whose quoting is invalid. `'throw'`
   * (default) fails the parse. `'report'` yields it as a command with
   * `invalid` set and carries on with the next line — which is what
   * `redis-cli` does, printing "Invalid argument(s)".
   */
  readonly invalidLines?: 'throw' | 'report';
}

export class RedisDumpParseError extends RedisDumperError {
  constructor(
    message: string,
    readonly location: CommandLocation,
  ) {
    super('parse-error', message);
    this.name = 'RedisDumpParseError';
  }
}

const NEWLINE = 0x0a;
const CR = 0x0d;
const ASTERISK = 0x2a;
const DOLLAR = 0x24;
const DEFAULT_MAX_COMMAND_BYTES = 1024 * 1024 * 1024;

function isWhitespace(byte: number | undefined): boolean {
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0d ||
    byte === 0x0b ||
    byte === 0x0c
  );
}

/**
 * Push-based incremental parser for both dump formats.
 *
 * Feed it chunks with {@link push} — split anywhere, even inside an
 * argument or a `\r\n` — and it returns every command completed so far;
 * {@link end} flushes the last one. Memory use is bounded by the largest
 * single command, never by the size of the dump.
 *
 * Text follows `redis-cli`'s script handling: each line is split with
 * `sdssplitargs()`, blank lines are skipped, `quit`/`exit` end the script,
 * and a leading number repeats the command (`3 INCR counter`). RESP follows
 * the server's own request parser: an array of bulk strings, or — for a
 * line that does not start with `*` — an inline command.
 */
export class CommandParser {
  private readonly queue = new ByteQueue();
  private format: 'text' | 'resp' | undefined;
  private readonly maxCommandBytes: number;
  private readonly reportInvalid: boolean;
  /** Bytes consumed from the source so far. */
  private consumed = 0;
  /** 1-based line of the next unconsumed byte, counting every `\n` consumed. */
  private line = 1;
  /** Bytes of the queue already searched for a newline without finding one. */
  private searched = 0;
  private index = 0;
  private finished = false;
  private unterminated = false;

  constructor(options: CommandParserOptions = {}) {
    this.format =
      options.format === 'auto' || options.format === undefined ? undefined : options.format;
    this.maxCommandBytes = options.maxCommandBytes ?? DEFAULT_MAX_COMMAND_BYTES;
    this.reportInvalid = options.invalidLines === 'report';
  }

  /** The format in use, once it is known. */
  get detectedFormat(): 'text' | 'resp' | undefined {
    return this.format;
  }

  /**
   * `true` when a text dump's last line had no newline. `redis-cli` runs
   * such a line anyway, and so does this parser — but every dump this
   * package writes ends with one, so it is also the mark of a truncated file.
   */
  get endedWithoutNewline(): boolean {
    return this.unterminated;
  }

  /** Bytes of the source consumed by completed commands. */
  get bytesConsumed(): number {
    return this.consumed;
  }

  push(chunk: Buffer): ParsedCommand[] {
    this.queue.push(chunk);
    return this.drain(false);
  }

  end(): ParsedCommand[] {
    return this.drain(true);
  }

  private drain(final: boolean): ParsedCommand[] {
    const commands: ParsedCommand[] = [];
    while (!this.finished) {
      if (this.format === undefined && !this.detect(final)) {
        break;
      }
      const parsed = this.format === 'resp' ? this.nextResp(final) : this.nextText(final);
      if (parsed === undefined) {
        break;
      }
      commands.push(...parsed);
    }
    if (final && !this.finished && this.queue.length > 0) {
      throw new RedisDumpParseError('The dump ends in the middle of a command', {
        offset: this.consumed,
        line: this.line,
      });
    }
    return commands;
  }

  /** Decides the format from the first non-whitespace byte. */
  private detect(final: boolean): boolean {
    for (let at = 0; at < this.queue.length; at++) {
      const byte = this.queue.byteAt(at);
      if (!isWhitespace(byte)) {
        this.format = byte === ASTERISK ? 'resp' : 'text';
        return true;
      }
    }
    if (final) {
      // Empty or whitespace-only: a valid, empty text dump.
      this.format = 'text';
      return true;
    }
    return false;
  }

  private tooLarge(size: number): RedisDumpParseError {
    return new RedisDumpParseError(
      `A command of ${size} bytes exceeds maxCommandBytes (${this.maxCommandBytes})`,
      { offset: this.consumed, line: this.line },
    );
  }

  /** Takes one line (without its `\n`), or `undefined` if none is complete yet. */
  private takeLine(final: boolean): Buffer | undefined {
    const newline = this.queue.indexOf(NEWLINE, this.searched);
    if (newline === -1) {
      this.searched = this.queue.length;
      if (this.searched > this.maxCommandBytes) {
        throw this.tooLarge(this.searched);
      }
      if (!final || this.queue.length === 0) {
        return undefined;
      }
      const rest = this.queue.take(this.queue.length);
      this.consumed += rest.length;
      this.unterminated = true;
      this.searched = 0;
      return rest;
    }
    const line = this.queue.take(newline);
    this.queue.skip(1);
    this.consumed += newline + 1;
    this.searched = 0;
    return line;
  }

  private splitLine(line: Buffer, location: CommandLocation): Buffer[] | ParsedCommand {
    try {
      return splitArgs(line);
    } catch (error) {
      if (!(error instanceof SplitArgsError)) {
        throw error;
      }
      const message = `${error.message} (column ${error.column + 1})`;
      if (this.reportInvalid) {
        return { argv: [], index: this.index++, location, invalid: message };
      }
      throw new RedisDumpParseError(message, location);
    }
  }

  private nextText(final: boolean): ParsedCommand[] | undefined {
    for (;;) {
      const location = { offset: this.consumed, line: this.line };
      const line = this.takeLine(final);
      if (line === undefined) {
        return undefined;
      }
      this.line++;
      const argv = this.splitLine(line, location);
      if (!Array.isArray(argv)) {
        return [argv];
      }
      if (argv.length === 0) {
        continue;
      }
      const name = (argv[0] as Buffer).toString('latin1').toLowerCase();
      if (argv.length === 1 && (name === 'quit' || name === 'exit')) {
        this.finished = true;
        return [];
      }
      // redis-cli repeats a command prefixed with a count: `3 INCR counter`.
      let repeat = 1;
      let command = argv;
      if (argv.length > 1 && /^[1-9]\d{0,5}$/.test(name)) {
        repeat = Number(name);
        command = argv.slice(1);
      }
      const parsed: ParsedCommand[] = [];
      for (let time = 0; time < repeat; time++) {
        parsed.push({ argv: command, index: this.index++, location });
      }
      return parsed;
    }
  }

  private nextResp(final: boolean): ParsedCommand[] | undefined {
    // Skip blank space between commands (a trailing newline, `\r\n` pairs).
    let skip = 0;
    while (skip < this.queue.length && isWhitespace(this.queue.byteAt(skip))) {
      skip++;
    }
    if (skip > 0) {
      for (let at = 0; at < skip; at++) {
        if (this.queue.byteAt(at) === NEWLINE) {
          this.line++;
        }
      }
      this.queue.skip(skip);
      this.consumed += skip;
      this.searched = 0;
    }
    if (this.queue.length === 0) {
      return undefined;
    }
    if (this.queue.byteAt(0) !== ASTERISK) {
      // An inline command, which the server splits with sdssplitargs too.
      return this.nextText(final);
    }

    const location = { offset: this.consumed, line: this.line };
    // Parse without consuming, so an incomplete command waits for more input.
    let cursor = 0;
    const readHeader = (marker: number): number | undefined => {
      if (cursor >= this.queue.length) {
        return undefined;
      }
      if (this.queue.byteAt(cursor) !== marker) {
        throw new RedisDumpParseError(
          `Expected '${String.fromCharCode(marker)}' in RESP input, found byte 0x${(
            this.queue.byteAt(cursor) ?? 0
          ).toString(16)}`,
          { offset: this.consumed + cursor },
        );
      }
      const newline = this.queue.indexOf(NEWLINE, cursor);
      if (newline === -1) {
        if (this.queue.length - cursor > 32) {
          throw new RedisDumpParseError('Malformed RESP length header', {
            offset: this.consumed + cursor,
          });
        }
        return undefined;
      }
      let text = '';
      for (let at = cursor + 1; at < newline; at++) {
        text += String.fromCharCode(this.queue.byteAt(at) as number);
      }
      if (text.endsWith('\r')) {
        text = text.slice(0, -1);
      }
      if (!/^\d+$/.test(text)) {
        throw new RedisDumpParseError(`Malformed RESP length ${JSON.stringify(text)}`, {
          offset: this.consumed + cursor,
        });
      }
      cursor = newline + 1;
      return Number(text);
    };

    const count = readHeader(ASTERISK);
    if (count === undefined) {
      return undefined;
    }
    const lengths: number[] = [];
    let total = 0;
    for (let argument = 0; argument < count; argument++) {
      const length = readHeader(DOLLAR);
      if (length === undefined) {
        return undefined;
      }
      total += length;
      if (total > this.maxCommandBytes) {
        throw this.tooLarge(total);
      }
      const bodyStart = cursor;
      if (this.queue.length < bodyStart + length + 2) {
        return undefined;
      }
      if (
        this.queue.byteAt(bodyStart + length) !== CR ||
        this.queue.byteAt(bodyStart + length + 1) !== NEWLINE
      ) {
        throw new RedisDumpParseError('A RESP bulk string is not followed by CRLF', {
          offset: this.consumed + bodyStart + length,
        });
      }
      lengths.push(length);
      cursor = bodyStart + length + 2;
    }

    // Complete: now consume it for real.
    const argv: Buffer[] = [];
    const header = (): void => {
      const newline = this.queue.indexOf(NEWLINE);
      this.queue.skip(newline + 1);
      this.consumed += newline + 1;
    };
    header();
    for (const length of lengths) {
      header();
      argv.push(this.queue.take(length));
      this.queue.skip(2);
      this.consumed += length + 2;
    }
    this.searched = 0;
    if (argv.length === 0) {
      return [];
    }
    return [{ argv, index: this.index++, location }];
  }
}

/** Parses a whole dump held in memory. */
export function parseRedisCommands(
  input: string | Buffer,
  options: CommandParserOptions = {},
): ParsedCommand[] {
  const parser = new CommandParser(options);
  return [
    ...parser.push(typeof input === 'string' ? Buffer.from(input, 'utf8') : input),
    ...parser.end(),
  ];
}

/** Parses a dump incrementally from any source, yielding commands as they complete. */
export async function* streamRedisCommands(
  source: RedisDumpSource,
  options: CommandParserOptions = {},
  parser: CommandParser = new CommandParser(options),
): AsyncGenerator<ParsedCommand> {
  for await (const chunk of readSource(source)) {
    yield* parser.push(chunk);
  }
  yield* parser.end();
}
