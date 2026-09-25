const MAX_SEQUENCE = (1n << 64n) - 1n;

/** Parses a stream entry id `ms-seq`. */
export function parseStreamId(id: string): { ms: bigint; seq: bigint } {
  const match = /^(\d+)-(\d+)$/.exec(id);
  if (!match) {
    throw new RangeError(`Not a stream entry id: ${JSON.stringify(id)}`);
  }
  return { ms: BigInt(match[1] as string), seq: BigInt(match[2] as string) };
}

/**
 * The smallest id strictly greater than `id`.
 *
 * Used to page through `XRANGE`/`XPENDING` without the exclusive-range
 * syntax (`(id`), which only exists from Redis 6.2 — so paging works the
 * same on every supported source.
 */
export function nextStreamId(id: string): string {
  const { ms, seq } = parseStreamId(id);
  return seq === MAX_SEQUENCE ? `${ms + 1n}-0` : `${ms}-${seq + 1n}`;
}
