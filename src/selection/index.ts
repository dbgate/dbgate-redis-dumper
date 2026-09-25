import type { RedisKeyType } from '../model/index.js';
import { matchGlob } from './glob.js';

export * from './glob.js';

/** Which keys a dump includes. Every filter narrows; with none, every key is dumped. */
export interface DumpSelection {
  /**
   * A single glob pattern passed to `SCAN ... MATCH`, so the filtering
   * happens on the server and non-matching keys never cross the network.
   */
  readonly match?: string | Buffer;
  /**
   * Further glob patterns a key must match at least one of. Applied on the
   * client, with Redis's own matching rules.
   */
  readonly include?: readonly (string | Buffer)[];
  /** Glob patterns excluding any key that matches one of them, applied after `include`. */
  readonly exclude?: readonly (string | Buffer)[];
  /**
   * Key types to include (`TYPE` replies: `'string'`, `'hash'`, ... or a
   * module type name). A single type is pushed down as `SCAN ... TYPE` on
   * Redis 6.0+.
   */
  readonly types?: readonly RedisKeyType[];
  /**
   * An explicit list of keys, dumped in this order without a `SCAN`. Keys
   * that do not exist are reported as `key-vanished` diagnostics. The
   * other filters still apply.
   */
  readonly keys?: readonly (string | Buffer)[];
}

/** True when `key` passes the client-side filters of `selection`. */
export function keyMatchesSelection(key: Buffer, selection: DumpSelection | undefined): boolean {
  if (!selection) {
    return true;
  }
  if (selection.keys && selection.match !== undefined && !matchGlob(selection.match, key)) {
    return false;
  }
  if (selection.include && selection.include.length > 0) {
    if (!selection.include.some(pattern => matchGlob(pattern, key))) {
      return false;
    }
  }
  if (selection.exclude?.some(pattern => matchGlob(pattern, key))) {
    return false;
  }
  return true;
}

/** True when `type` passes the type filter of `selection`. */
export function typeMatchesSelection(type: string, selection: DumpSelection | undefined): boolean {
  return !selection?.types || selection.types.length === 0 || selection.types.includes(type);
}
