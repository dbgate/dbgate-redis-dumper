import type { RedisArgument, RedisConnection } from '../connection/types.js';
import { toBuffer } from '../protocol/arguments.js';
import { replyToArray, replyToBufferArray, replyToString } from '../protocol/replies.js';
import type { DumpSelection } from '../selection/index.js';
import { keyMatchesSelection } from '../selection/index.js';
import { throwIfAborted } from '../utils/errors.js';
import type { RedisServerCapabilities } from '../version/types.js';

export interface KeyScanOptions {
  readonly selection?: DumpSelection;
  /** `SCAN ... COUNT` hint, and the page size for an explicit key list. */
  readonly count: number;
  /**
   * Drop keys `SCAN` returns more than once. Defaults to `true`.
   *
   * `SCAN` guarantees every key present for the whole scan is returned *at
   * least* once — a rehash during the scan can return some twice. Writing a
   * key twice is harmless with `replace` (the second copy replaces the
   * first) but wasteful, and with `replace: false` it would push a list's
   * items twice. Deduplication costs memory proportional to the number of
   * keys in the database.
   */
  readonly deduplicate?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Yields the selected keys of the connection's current database, one page
 * at a time, as raw bytes.
 */
export async function* scanKeys(
  connection: RedisConnection,
  capabilities: RedisServerCapabilities,
  options: KeyScanOptions,
): AsyncGenerator<Buffer[]> {
  const { selection, count, signal } = options;
  const seen = options.deduplicate === false ? null : new Set<string>();

  const accept = (key: Buffer): boolean => {
    if (!keyMatchesSelection(key, selection)) {
      return false;
    }
    if (seen) {
      // latin1 maps every byte to one code unit, so this is lossless for binary keys.
      const identity = key.toString('latin1');
      if (seen.has(identity)) {
        return false;
      }
      seen.add(identity);
    }
    return true;
  };

  if (selection?.keys) {
    for (let at = 0; at < selection.keys.length; at += count) {
      throwIfAborted(signal);
      const page = selection.keys
        .slice(at, at + count)
        .map(toBuffer)
        .filter(accept);
      if (page.length > 0) {
        yield page;
      }
    }
    return;
  }

  const suffix: RedisArgument[] = [];
  if (selection?.match !== undefined) {
    suffix.push('MATCH', selection.match);
  }
  suffix.push('COUNT', count);
  if (selection?.types?.length === 1 && capabilities.scanType) {
    suffix.push('TYPE', selection.types[0] as string);
  }

  let cursor = '0';
  do {
    throwIfAborted(signal);
    const reply = replyToArray(await connection.call(['SCAN', cursor, ...suffix], signal));
    cursor = replyToString(reply[0] ?? null);
    const page = replyToBufferArray(reply[1] ?? []).filter(accept);
    if (page.length > 0) {
      yield page;
    }
  } while (cursor !== '0');
}
