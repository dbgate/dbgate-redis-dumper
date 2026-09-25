/** A small deterministic PRNG (mulberry32), so property tests are reproducible. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deterministic random bytes, biased towards the bytes most likely to break
 * an encoder: quotes, backslashes, whitespace, CR/LF, NUL and high bytes.
 */
export function randomBytes(seed: number, length: number): Buffer {
  const random = seededRandom(seed);
  const tricky = [0x00, 0x0a, 0x0d, 0x09, 0x20, 0x22, 0x27, 0x5c, 0x78, 0x2a, 0x24, 0xff, 0xc3];
  const out = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index++) {
    out[index] =
      random() < 0.3
        ? (tricky[Math.floor(random() * tricky.length)] as number)
        : Math.floor(random() * 256);
  }
  return out;
}
