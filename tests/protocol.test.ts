import { describe, expect, it } from 'vitest';
import { encodeRespCommand } from '../src/protocol/respEncoding.js';
import { encodeTextArgument, encodeTextCommand } from '../src/protocol/textEncoding.js';
import { splitArgs } from '../src/restore/splitArgs.js';
import { randomBytes, seededRandom } from './fixtures.js';

const text = (value: Buffer): string => value.toString('latin1');

describe('text encoding', () => {
  it('leaves plain tokens bare', () => {
    expect(text(encodeTextArgument('user:1001'))).toBe('user:1001');
    expect(text(encodeTextArgument(42))).toBe('42');
    expect(text(encodeTextArgument('-inf'))).toBe('-inf');
  });

  it('quotes whatever sdssplitargs would otherwise misread', () => {
    expect(text(encodeTextArgument(''))).toBe('""');
    expect(text(encodeTextArgument('two words'))).toBe('"two words"');
    expect(text(encodeTextArgument('say "hi"'))).toBe('"say \\"hi\\""');
    expect(text(encodeTextArgument("it's"))).toBe(`"it's"`);
    expect(text(encodeTextArgument('back\\slash'))).toBe('"back\\\\slash"');
    expect(text(encodeTextArgument('a\nb\r\tc'))).toBe('"a\\nb\\r\\tc"');
  });

  it('never writes a raw newline, so a command is always exactly one line', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const line = encodeTextCommand(['SET', randomBytes(seed, 64), randomBytes(seed + 1000, 64)]);
      expect(line.indexOf(0x0a)).toBe(line.length - 1);
    }
  });

  it('keeps valid UTF-8 readable and escapes everything else byte by byte', () => {
    expect(encodeTextArgument('žluťoučký kůň').toString('utf8')).toBe('"žluťoučký kůň"');
    expect(text(encodeTextArgument(Buffer.from([0xc3, 0x28])))).toBe('"\\xc3("');
    expect(text(encodeTextArgument('ž', { escapeNonAscii: true }))).toBe('"\\xc5\\xbe"');
  });

  it('round-trips every byte sequence through splitArgs, the grammar redis-cli reads', () => {
    const random = seededRandom(7);
    for (let round = 0; round < 500; round++) {
      const command = Array.from({ length: 1 + Math.floor(random() * 5) }, (_, at) =>
        randomBytes(round * 10 + at, Math.floor(random() * 40)),
      );
      for (const escapeNonAscii of [false, true]) {
        const line = encodeTextCommand(command, { escapeNonAscii });
        expect(splitArgs(line.subarray(0, -1))).toEqual(command);
      }
    }
  });
});

describe('RESP encoding', () => {
  it('writes an array of length-prefixed bulk strings', () => {
    expect(text(encodeRespCommand(['SET', 'k', Buffer.from([0x00, 0x0d, 0x0a])]))).toBe(
      '*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$3\r\n\x00\r\n\r\n',
    );
    expect(text(encodeRespCommand(['PEXPIREAT', 'k', 1_700_000_000_000]))).toBe(
      '*3\r\n$9\r\nPEXPIREAT\r\n$1\r\nk\r\n$13\r\n1700000000000\r\n',
    );
  });

  it('counts bytes, not characters', () => {
    expect(text(encodeRespCommand(['ECHO', 'ž']))).toContain('$2\r\n');
  });

  it('refuses a non-finite number rather than writing "NaN"', () => {
    expect(() => encodeRespCommand(['EXPIRE', 'k', Number.NaN])).toThrow(TypeError);
  });
});

describe('splitArgs (sdssplitargs)', () => {
  const split = (line: string): string[] => splitArgs(Buffer.from(line, 'latin1')).map(text);

  it('splits on whitespace and skips blank lines', () => {
    expect(split('  SET   a\tb  ')).toEqual(['SET', 'a', 'b']);
    expect(split('')).toEqual([]);
    expect(split('   \t ')).toEqual([]);
  });

  it('decodes double-quoted escapes', () => {
    expect(split('"a\\x41\\n\\r\\t\\b\\a\\"\\\\\\q"')).toEqual(['aA\n\r\t\b\x07"\\q']);
  });

  it('treats a malformed \\x escape as a literal x', () => {
    expect(split('"\\xZZ"')).toEqual(['xZZ']);
  });

  it("only knows \\' inside single quotes", () => {
    expect(split(`'it\\'s' '\\n'`)).toEqual(["it's", '\\n']);
  });

  it('switches into quoted mode in the middle of a token, as redis-cli does', () => {
    expect(split('ab"c d" e')).toEqual(['abc d', 'e']);
  });

  it('rejects unbalanced quotes and a closing quote glued to the next token', () => {
    expect(() => split('"open')).toThrow('Unbalanced');
    expect(() => split("'open")).toThrow('Unbalanced');
    expect(() => split('"a"b')).toThrow('closing quote');
  });

  it('stops at a NUL byte, as the C string does', () => {
    expect(splitArgs(Buffer.from('SET a\0 ignored'))).toEqual([
      Buffer.from('SET'),
      Buffer.from('a'),
    ]);
  });

  it('splits a multi-megabyte argument in linear time', () => {
    const value = 'x'.repeat(8 * 1024 * 1024);
    const started = Date.now();
    const [, argument] = splitArgs(Buffer.from(`SET "${value}"`));
    expect(argument?.length).toBe(value.length);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
