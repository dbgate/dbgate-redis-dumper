import { describe, expect, it } from 'vitest';
import type { RedisCommand } from '../src/connection/types.js';
import { encodeRespCommand } from '../src/protocol/respEncoding.js';
import { encodeTextCommand } from '../src/protocol/textEncoding.js';
import { ByteQueue } from '../src/restore/byteQueue.js';
import type { ParsedCommand } from '../src/restore/parser.js';
import {
  CommandParser,
  parseRedisCommands,
  RedisDumpParseError,
  streamRedisCommands,
} from '../src/restore/parser.js';
import { randomBytes } from './fixtures.js';

const argv = (commands: readonly ParsedCommand[]): string[][] =>
  commands.map(command => command.argv.map(argument => argument.toString('latin1')));

const COMMANDS: RedisCommand[] = [
  ['SET', 'plain', 'value'],
  ['SET', Buffer.from([0x00, 0x0d, 0x0a, 0x22]), Buffer.from('')],
  ['HSET', 'h', 'field with spaces', 'a\r\nb', "it's", '\\'],
  ['RPUSH', 'l', randomBytes(1, 300), randomBytes(2, 1)],
  ['PEXPIREAT', 'plain', 1_900_000_000_000],
];

function encodeAll(format: 'text' | 'resp'): Buffer {
  return Buffer.concat(
    COMMANDS.map(command =>
      format === 'resp' ? encodeRespCommand(command) : encodeTextCommand(command),
    ),
  );
}

function parseInChunks(input: Buffer, cut: (at: number) => boolean): ParsedCommand[] {
  const parser = new CommandParser();
  const out: ParsedCommand[] = [];
  let start = 0;
  for (let at = 1; at <= input.length; at++) {
    if (at === input.length || cut(at)) {
      out.push(...parser.push(input.subarray(start, at)));
      start = at;
    }
  }
  out.push(...parser.end());
  return out;
}

describe('CommandParser', () => {
  for (const format of ['text', 'resp'] as const) {
    describe(`${format} format`, () => {
      const input = encodeAll(format);
      const expected = COMMANDS.map(command =>
        command.map(argument => Buffer.from(String(argument)).toString('latin1')),
      );
      // Buffers stringify differently; compare through the encoders instead.
      const reference = argv(parseRedisCommands(input));

      it('detects the format and parses every command back exactly', () => {
        const parser = new CommandParser();
        const parsed = [...parser.push(input), ...parser.end()];
        expect(parser.detectedFormat).toBe(format);
        expect(parsed.map(command => command.argv)).toEqual(
          COMMANDS.map(command =>
            command.map(argument =>
              Buffer.isBuffer(argument) ? argument : Buffer.from(String(argument)),
            ),
          ),
        );
        expect(parsed.map(command => command.index)).toEqual([0, 1, 2, 3, 4]);
        expect(expected).toHaveLength(5);
      });

      it('gives the same result at every single split point', () => {
        for (let split = 1; split < input.length; split++) {
          expect(argv(parseInChunks(input, at => at === split)), `split at ${split}`).toEqual(
            reference,
          );
        }
      });

      it('gives the same result fed one byte at a time', () => {
        expect(argv(parseInChunks(input, () => true))).toEqual(reference);
      });

      it('reports where each command starts', () => {
        const parsed = parseRedisCommands(input);
        let offset = 0;
        COMMANDS.forEach((command, at) => {
          expect(parsed[at]?.location.offset).toBe(offset);
          offset += (format === 'resp' ? encodeRespCommand(command) : encodeTextCommand(command))
            .length;
        });
      });

      it('flags a dump that ends in the middle of a command', () => {
        const truncated = input.subarray(0, input.length - 3);
        if (format === 'resp') {
          expect(() => parseRedisCommands(truncated)).toThrow(RedisDumpParseError);
        } else {
          // redis-cli runs an unterminated last line, so the parser does too —
          // but says so, since that is what a truncated file looks like.
          const parser = new CommandParser();
          parser.push(truncated);
          parser.end();
          expect(parser.endedWithoutNewline).toBe(true);
        }
      });
    });
  }

  it('accepts inline commands between RESP commands, as the server does', () => {
    const input = Buffer.concat([
      encodeRespCommand(['SET', 'a', '1']),
      Buffer.from('PING\r\n'),
      encodeRespCommand(['GET', 'a']),
    ]);
    expect(argv(parseRedisCommands(input))).toEqual([['SET', 'a', '1'], ['PING'], ['GET', 'a']]);
  });

  it('treats an empty or whitespace-only dump as empty text', () => {
    expect(parseRedisCommands('')).toEqual([]);
    expect(parseRedisCommands('\n\n  \n')).toEqual([]);
  });

  it('follows redis-cli: quit/exit end the script, a leading count repeats', () => {
    expect(argv(parseRedisCommands('2 INCR c\nSET a 1\nexit\nSET b 2\n'))).toEqual([
      ['INCR', 'c'],
      ['INCR', 'c'],
      ['SET', 'a', '1'],
    ]);
    // A key named "quit" is data, not the command.
    expect(argv(parseRedisCommands('SET quit 1\n'))).toEqual([['SET', 'quit', '1']]);
  });

  it('numbers lines, counting CRLF files correctly', () => {
    const parsed = parseRedisCommands('SET a 1\r\n\r\nSET b 2\r\n');
    expect(parsed.map(command => command.location.line)).toEqual([1, 3]);
    expect(argv(parsed)).toEqual([
      ['SET', 'a', '1'],
      ['SET', 'b', '2'],
    ]);
  });

  it('throws on invalid quoting by default, and reports it on request', () => {
    expect(() => parseRedisCommands('SET "a 1\n')).toThrow(/line|Unbalanced/);
    const parsed = parseRedisCommands('SET "a 1\nSET b 2\n', { invalidLines: 'report' });
    expect(parsed[0]).toMatchObject({ argv: [], invalid: expect.stringContaining('Unbalanced') });
    expect(argv(parsed.slice(1))).toEqual([['SET', 'b', '2']]);
  });

  it('refuses malformed RESP with an offset', () => {
    expect(() => parseRedisCommands('*1\r\n$x\r\n')).toThrow(RedisDumpParseError);
    expect(() => parseRedisCommands('*1\r\n$1\r\nab\r\n')).toThrow('CRLF');
    try {
      parseRedisCommands('*1\r\n$1\r\nA\r\n*1\r\n#');
    } catch (error) {
      expect((error as RedisDumpParseError).location.offset).toBe(15);
    }
  });

  it('refuses a command above maxCommandBytes instead of buffering it', () => {
    expect(() =>
      parseRedisCommands(encodeRespCommand(['SET', 'k', 'x'.repeat(100)]), { maxCommandBytes: 50 }),
    ).toThrow('maxCommandBytes');
    expect(() => parseRedisCommands(`SET k ${'x'.repeat(100)}`, { maxCommandBytes: 50 })).toThrow(
      'maxCommandBytes',
    );
  });

  it('parses a large value split into many small chunks in linear time', async () => {
    const value = randomBytes(3, 16 * 1024 * 1024);
    for (const format of ['resp', 'text'] as const) {
      const input =
        format === 'resp'
          ? encodeRespCommand(['SET', 'big', value])
          : encodeTextCommand(['SET', 'big', value]);
      const chunks = function* (): Generator<Buffer> {
        for (let at = 0; at < input.length; at += 4096) yield input.subarray(at, at + 4096);
      };
      const started = Date.now();
      const parsed: ParsedCommand[] = [];
      for await (const command of streamRedisCommands(chunks())) parsed.push(command);
      expect(parsed[0]?.argv[2]?.equals(value), format).toBe(true);
      expect(Date.now() - started, format).toBeLessThan(10_000);
    }
  });
});

describe('ByteQueue', () => {
  it('finds, takes and skips across chunk boundaries', () => {
    const queue = new ByteQueue();
    queue.push(Buffer.from('ab'));
    queue.push(Buffer.from('c\nd'));
    queue.push(Buffer.from('ef\n'));
    expect(queue.length).toBe(8);
    expect(queue.indexOf(0x0a)).toBe(3);
    expect(queue.indexOf(0x0a, 4)).toBe(7);
    expect(queue.byteAt(4)).toBe(0x64);
    expect(queue.take(3).toString()).toBe('abc');
    queue.skip(1);
    expect(queue.indexOf(0x0a)).toBe(3);
    expect(queue.take(4).toString()).toBe('def\n');
    expect(queue.length).toBe(0);
    expect(() => queue.take(1)).toThrow(RangeError);
  });
});
