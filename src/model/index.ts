export type RedisDiagnosticSeverity = 'info' | 'warning' | 'error';

/**
 * A structured diagnostic surfaced by the dump or restore. Diagnostics are
 * never thrown for recoverable conditions; callers inspect them explicitly
 * instead of parsing log text.
 */
export interface RedisDiagnostic {
  readonly severity: RedisDiagnosticSeverity;
  /** Stable machine-readable identifier, e.g. `"key-vanished"`. */
  readonly code: string;
  readonly message: string;
  /** Logical database the diagnostic concerns, when it concerns one. */
  readonly database?: number;
  /** Printable form of the key the diagnostic concerns, when it concerns one. */
  readonly key?: string;
}

/** The value types Redis itself reports from `TYPE`, which the dump rebuilds with commands. */
export type RedisCoreKeyType = 'string' | 'hash' | 'list' | 'set' | 'zset' | 'stream';

export const REDIS_CORE_KEY_TYPES: readonly RedisCoreKeyType[] = [
  'string',
  'hash',
  'list',
  'set',
  'zset',
  'stream',
];

/**
 * Any `TYPE` reply: a core type, or a module type name such as `ReJSON-RL`
 * (RedisJSON), `MBbloom--` (RedisBloom) or `vectorset` (Redis 8).
 */
export type RedisKeyType = RedisCoreKeyType | (string & {});

export function isCoreKeyType(type: string): type is RedisCoreKeyType {
  return (REDIS_CORE_KEY_TYPES as readonly string[]).includes(type);
}

/**
 * Collects diagnostics, collapsing repeats of the same informational code
 * so a condition that applies to a million keys reports once, with a count,
 * instead of a million times.
 */
export class DiagnosticCollector {
  private readonly items: RedisDiagnostic[] = [];
  /** Code → index of its first occurrence in {@link items}, for codes recorded with {@link addOnce}. */
  private readonly firstIndexByCode = new Map<string, number>();
  /** Index in {@link items} → how many times that code was reported. */
  private readonly countByIndex = new Map<number, number>();

  add(diagnostic: RedisDiagnostic): void {
    this.items.push(diagnostic);
  }

  /** Records `diagnostic` the first time its code is seen; later ones only bump a counter. */
  addOnce(diagnostic: RedisDiagnostic): void {
    const index = this.firstIndexByCode.get(diagnostic.code);
    if (index !== undefined) {
      this.countByIndex.set(index, (this.countByIndex.get(index) ?? 1) + 1);
      return;
    }
    this.firstIndexByCode.set(diagnostic.code, this.items.length);
    this.items.push(diagnostic);
  }

  toArray(): RedisDiagnostic[] {
    return this.items.map((item, index) => {
      const count = this.countByIndex.get(index);
      return count ? { ...item, message: `${item.message} (${count} occurrences)` } : item;
    });
  }
}
