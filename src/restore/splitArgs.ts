/**
 * `sdssplitargs()` from Redis's `sds.c`, ported to bytes: how `redis-cli`
 * splits each line of a script into arguments, and how the server splits an
 * inline command.
 *
 * Restoring a `redis-cli` script correctly means agreeing with `redis-cli`
 * on every line, including the odd ones, so this follows the C code rather
 * than a tidier grammar:
 *
 * - Outside quotes, whitespace separates arguments and a quote character
 *   switches into quoted mode *in the middle of an argument*: `ab"c d"`
 *   is the single argument `abc d`.
 * - Inside double quotes: `\xHH`, `\n`, `\r`, `\t`, `\b`, `\a` are escapes,
 *   and a backslash before any other byte yields that byte.
 * - Inside single quotes only `\'` is an escape.
 * - A closing quote must be followed by whitespace or the end of the line.
 * - A NUL byte ends the line, as it ends the C string.
 */

export class SplitArgsError extends Error {
  constructor(
    message: string,
    /** Byte offset within the line where the problem was found. */
    readonly column: number,
  ) {
    super(message);
    this.name = 'SplitArgsError';
  }
}

function isSpace(byte: number | undefined): boolean {
  // C's isspace() in the "C" locale.
  return (
    byte === 0x20 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0b ||
    byte === 0x0c ||
    byte === 0x0d
  );
}

function hexValue(byte: number | undefined): number {
  if (byte === undefined) return -1;
  if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
  if (byte >= 0x61 && byte <= 0x66) return byte - 0x61 + 10;
  if (byte >= 0x41 && byte <= 0x46) return byte - 0x41 + 10;
  return -1;
}

/** Splits one line. Returns `[]` for a blank line; throws {@link SplitArgsError} on unbalanced quotes. */
export function splitArgs(line: Buffer): Buffer[] {
  const nul = line.indexOf(0);
  const end = nul === -1 ? line.length : nul;
  const args: Buffer[] = [];
  // Every argument is written into one scratch buffer and copied out once,
  // so a line holding a multi-megabyte value is still split in linear time.
  const scratch = Buffer.allocUnsafe(end);
  let p = 0;

  for (;;) {
    while (p < end && isSpace(line[p])) {
      p++;
    }
    if (p >= end) {
      return args;
    }

    let at = 0;
    let inDouble = false;
    let inSingle = false;
    let done = false;
    while (!done) {
      const c = p < end ? (line[p] as number) : undefined;
      const next = p + 1 < end ? line[p + 1] : undefined;
      if (inDouble) {
        if (
          c === 0x5c &&
          next === 0x78 &&
          p + 3 < end &&
          hexValue(line[p + 2]) >= 0 &&
          hexValue(line[p + 3]) >= 0
        ) {
          scratch[at++] = hexValue(line[p + 2]) * 16 + hexValue(line[p + 3]);
          p += 3;
        } else if (c === 0x5c && next !== undefined) {
          p++;
          scratch[at++] = ESCAPES.get(next) ?? next;
        } else if (c === 0x22) {
          if (next !== undefined && !isSpace(next)) {
            throw new SplitArgsError('A closing quote must be followed by a space', p);
          }
          done = true;
        } else if (c === undefined) {
          throw new SplitArgsError('Unbalanced double quote', p);
        } else {
          scratch[at++] = c;
        }
      } else if (inSingle) {
        if (c === 0x5c && next === 0x27) {
          p++;
          scratch[at++] = 0x27;
        } else if (c === 0x27) {
          if (next !== undefined && !isSpace(next)) {
            throw new SplitArgsError('A closing quote must be followed by a space', p);
          }
          done = true;
        } else if (c === undefined) {
          throw new SplitArgsError('Unbalanced single quote', p);
        } else {
          scratch[at++] = c;
        }
      } else if (c === undefined || c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
        done = true;
      } else if (c === 0x22) {
        inDouble = true;
      } else if (c === 0x27) {
        inSingle = true;
      } else {
        scratch[at++] = c;
      }
      if (p < end) {
        p++;
      }
    }
    args.push(Buffer.from(scratch.subarray(0, at)));
  }
}

/** The single-letter escapes of a double-quoted argument. */
const ESCAPES = new Map<number, number>([
  [0x6e, 0x0a], // \n
  [0x72, 0x0d], // \r
  [0x74, 0x09], // \t
  [0x62, 0x08], // \b
  [0x61, 0x07], // \a
]);
