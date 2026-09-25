import { isUtf8 } from 'node:buffer';
import type { RedisArgument, RedisCommand } from '../connection/types.js';
import { toBuffer } from './arguments.js';

/**
 * The `text` dump format: one command per line, each argument written the
 * way `redis-cli` itself reads it.
 *
 * `redis-cli` reading a script from stdin (`redis-cli < dump.redis`) splits
 * every line with `sdssplitargs()`, so that function's grammar *is* the
 * format. An argument is either bare — a run of bytes containing no
 * whitespace and no quote — or double-quoted, where `\"`, `\\`, `\n`, `\r`,
 * `\t`, `\b`, `\a` and `\xHH` are escapes and every other byte stands for
 * itself. A quoted argument must be followed by whitespace or the end of
 * the line.
 *
 * Everything this module writes is valid under exactly those rules, and
 * nothing more: no comments (redis-cli would send `#` to the server as a
 * command), and never a raw newline inside an argument (redis-cli is
 * line-based, so a newline always ends the command).
 */
export interface TextEncodingOptions {
  /**
   * Write every byte outside printable ASCII as `\xHH`, even inside valid
   * UTF-8 text. Defaults to `false`: an argument that is valid UTF-8 keeps
   * its characters as they are, so `"Příliš žluťoučký kůň"` stays readable.
   * Arguments that are not valid UTF-8 are always escaped byte by byte,
   * whatever this is set to.
   */
  readonly escapeNonAscii?: boolean;
}

const BACKSLASH = 0x5c;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const HEX = '0123456789abcdef';

/** Bytes that may appear in an unquoted argument: printable ASCII except quotes and backslash. */
function isBareByte(byte: number): boolean {
  return (
    byte > 0x20 &&
    byte < 0x7f &&
    byte !== DOUBLE_QUOTE &&
    byte !== SINGLE_QUOTE &&
    byte !== BACKSLASH
  );
}

function canBeBare(bytes: Buffer): boolean {
  if (bytes.length === 0) {
    return false;
  }
  for (const byte of bytes) {
    if (!isBareByte(byte)) {
      return false;
    }
  }
  return true;
}

/** Encodes one argument as `sdssplitargs()` will read it back. */
export function encodeTextArgument(
  argument: RedisArgument,
  options: TextEncodingOptions = {},
): Buffer {
  const bytes = toBuffer(argument);
  if (canBeBare(bytes)) {
    return bytes;
  }

  const keepUtf8 = !options.escapeNonAscii && isUtf8(bytes);
  // Worst case every byte becomes `\xHH`, plus the two quotes.
  const out = Buffer.allocUnsafe(bytes.length * 4 + 2);
  let at = 0;
  out[at++] = DOUBLE_QUOTE;
  for (const byte of bytes) {
    switch (byte) {
      case BACKSLASH:
        out[at++] = BACKSLASH;
        out[at++] = BACKSLASH;
        continue;
      case DOUBLE_QUOTE:
        out[at++] = BACKSLASH;
        out[at++] = DOUBLE_QUOTE;
        continue;
      case 0x0a:
        out[at++] = BACKSLASH;
        out[at++] = 0x6e; // n
        continue;
      case 0x0d:
        out[at++] = BACKSLASH;
        out[at++] = 0x72; // r
        continue;
      case 0x09:
        out[at++] = BACKSLASH;
        out[at++] = 0x74; // t
        continue;
    }
    if ((byte >= 0x20 && byte < 0x7f) || (keepUtf8 && byte >= 0x80)) {
      out[at++] = byte;
    } else {
      out[at++] = BACKSLASH;
      out[at++] = 0x78; // x
      out[at++] = HEX.charCodeAt(byte >> 4);
      out[at++] = HEX.charCodeAt(byte & 0x0f);
    }
  }
  out[at++] = DOUBLE_QUOTE;
  return out.subarray(0, at);
}

const SPACE = Buffer.from(' ', 'latin1');
const NEWLINE = Buffer.from('\n', 'latin1');

/** One command as one `redis-cli` script line, including its trailing newline. */
export function encodeTextCommand(
  command: RedisCommand,
  options: TextEncodingOptions = {},
): Buffer {
  const parts: Buffer[] = [];
  for (const [index, argument] of command.entries()) {
    if (index > 0) {
      parts.push(SPACE);
    }
    parts.push(encodeTextArgument(argument, options));
  }
  parts.push(NEWLINE);
  return Buffer.concat(parts);
}
