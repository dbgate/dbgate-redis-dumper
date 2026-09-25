/**
 * Redis's own glob matcher (`stringmatchlen()` in `util.c`), ported to bytes.
 *
 * Client-side filtering has to agree exactly with what `SCAN ... MATCH`
 * does on the server, or the same pattern would select different keys
 * depending on which side applied it. Supported: `*`, `?`, `[abc]`,
 * `[^abc]`, `[a-z]`, and `\` to escape the next byte.
 */
export function matchGlob(pattern: Buffer | string, subject: Buffer | string): boolean {
  const p = typeof pattern === 'string' ? Buffer.from(pattern, 'utf8') : pattern;
  const s = typeof subject === 'string' ? Buffer.from(subject, 'utf8') : subject;
  return matchFrom(p, 0, s, 0, 0);
}

/** Recursion depth bound, as in Redis, so a pathological pattern cannot exhaust the stack. */
const MAX_NESTING = 1000;

function matchFrom(p: Buffer, pi: number, s: Buffer, si: number, nesting: number): boolean {
  if (nesting > MAX_NESTING) {
    return false;
  }
  while (pi < p.length && si < s.length) {
    const c = p[pi] as number;
    if (c === 0x2a /* * */) {
      while (pi + 1 < p.length && p[pi + 1] === 0x2a) {
        pi++;
      }
      if (pi + 1 === p.length) {
        return true;
      }
      for (let at = si; at < s.length; at++) {
        if (matchFrom(p, pi + 1, s, at, nesting + 1)) {
          return true;
        }
      }
      return false;
    }
    if (c === 0x3f /* ? */) {
      si++;
      pi++;
      continue;
    }
    if (c === 0x5b /* [ */) {
      pi++;
      const negate = p[pi] === 0x5e; /* ^ */
      if (negate) {
        pi++;
      }
      let matched = false;
      const byte = s[si] as number;
      for (;;) {
        if (pi >= p.length) {
          // Unterminated class: Redis treats the end of the pattern as its end.
          pi--;
          break;
        }
        const current = p[pi] as number;
        if (current === 0x5c /* \ */ && pi + 1 < p.length) {
          pi++;
          if (p[pi] === byte) {
            matched = true;
          }
        } else if (current === 0x5d /* ] */) {
          break;
        } else if (pi + 2 < p.length && p[pi + 1] === 0x2d /* - */) {
          let start = current;
          let end = p[pi + 2] as number;
          if (start > end) {
            [start, end] = [end, start];
          }
          pi += 2;
          if (byte >= start && byte <= end) {
            matched = true;
          }
        } else if (current === byte) {
          matched = true;
        }
        pi++;
      }
      if (negate) {
        matched = !matched;
      }
      if (!matched) {
        return false;
      }
      si++;
      pi++;
      continue;
    }
    if (c === 0x5c /* \ */ && pi + 1 < p.length) {
      pi++;
    }
    if (p[pi] !== s[si]) {
      return false;
    }
    si++;
    pi++;
  }
  // The subject is exhausted: only trailing stars may remain.
  while (pi < p.length && p[pi] === 0x2a) {
    pi++;
  }
  return pi === p.length && si === s.length;
}
