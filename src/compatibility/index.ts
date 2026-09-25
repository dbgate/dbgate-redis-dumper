import type { RedisCommand } from '../connection/types.js';
import { argumentText, commandName, toBuffer } from '../protocol/arguments.js';
import { rdbVersionFor, versionAtLeast } from '../version/detect.js';
import type { RedisServerVersion } from '../version/types.js';

/**
 * A server feature a dump's commands depend on.
 *
 * A dump is written in the richest form the *source* supports, so it may
 * use syntax an older target rejects. Rather than guess the target at dump
 * time, every command is classified here — by the dump as it writes and by
 * {@link analyzeRedisDump} when reading a file back — so a preflight can
 * say exactly what a given target lacks before anything is restored.
 */
export type RedisFeature =
  /** `HSET` with more than one field (Redis 4.0). */
  | 'multi-field-hset'
  /** `XADD`, `XGROUP`, `XSETID`, `XCLAIM` (Redis 5.0). */
  | 'streams'
  /** `RESTORE ... ABSTTL` (Redis 5.0). */
  | 'restore-absttl'
  /** `XGROUP CREATECONSUMER` (Redis 6.2). */
  | 'xgroup-createconsumer'
  /** `XSETID ... ENTRIESADDED/MAXDELETEDID`, `XGROUP CREATE ... ENTRIESREAD` (Redis 7.0). */
  | 'stream-counters'
  /** `HPEXPIREAT` and relatives (Redis 7.4, Valkey 9.0). */
  | 'hash-field-expiration'
  /** `RESTORE` of a `DUMP` payload, bounded by its RDB version. */
  | 'restore-payload';

interface FeatureVersions {
  readonly redis: string;
  /** `undefined` when Valkey has no release with the feature. */
  readonly valkey?: string;
}

/** The first release of each flavor that accepts a feature. */
export const FEATURE_VERSIONS: Readonly<Record<RedisFeature, FeatureVersions>> = {
  'multi-field-hset': { redis: '4.0.0', valkey: '7.2.0' },
  streams: { redis: '5.0.0', valkey: '7.2.0' },
  'restore-absttl': { redis: '5.0.0', valkey: '7.2.0' },
  'xgroup-createconsumer': { redis: '6.2.0', valkey: '7.2.0' },
  'stream-counters': { redis: '7.0.0', valkey: '7.2.0' },
  'hash-field-expiration': { redis: '7.4.0', valkey: '9.0.0' },
  'restore-payload': { redis: '2.6.0', valkey: '7.2.0' },
};

const STREAM_COMMANDS = new Set(['XADD', 'XGROUP', 'XSETID', 'XCLAIM']);
const HASH_FIELD_EXPIRATION_COMMANDS = new Set([
  'HPEXPIREAT',
  'HEXPIREAT',
  'HPEXPIRE',
  'HEXPIRE',
  'HPERSIST',
]);

function hasOption(command: RedisCommand, option: string, from: number): boolean {
  for (let index = from; index < command.length; index++) {
    if (argumentText(command, index)?.toUpperCase() === option) {
      return true;
    }
  }
  return false;
}

/** The features one command depends on. */
export function featuresOfCommand(command: RedisCommand): RedisFeature[] {
  const name = commandName(command);
  const features: RedisFeature[] = [];
  if (name === 'HSET' && command.length > 4) {
    features.push('multi-field-hset');
  }
  if (STREAM_COMMANDS.has(name)) {
    features.push('streams');
  }
  if (HASH_FIELD_EXPIRATION_COMMANDS.has(name)) {
    features.push('hash-field-expiration');
  }
  if (name === 'XGROUP') {
    const sub = argumentText(command, 1)?.toUpperCase();
    if (sub === 'CREATECONSUMER') {
      features.push('xgroup-createconsumer');
    }
    if (sub === 'CREATE' && hasOption(command, 'ENTRIESREAD', 5)) {
      features.push('stream-counters');
    }
  }
  if (
    name === 'XSETID' &&
    (hasOption(command, 'ENTRIESADDED', 3) || hasOption(command, 'MAXDELETEDID', 3))
  ) {
    features.push('stream-counters');
  }
  if (name === 'RESTORE') {
    features.push('restore-payload');
    if (hasOption(command, 'ABSTTL', 4)) {
      features.push('restore-absttl');
    }
  }
  return features;
}

/**
 * The RDB serialization version of a `DUMP` payload: the two little-endian
 * bytes that precede its 8-byte CRC64 trailer. `undefined` for something too
 * short to be a payload.
 */
export function payloadRdbVersion(payload: Buffer): number | undefined {
  if (payload.length < 11) {
    return undefined;
  }
  return payload.readUInt16LE(payload.length - 10);
}

/** What a dump needs from the server it is restored onto. */
export interface DumpRequirements {
  /** Every feature at least one command uses, sorted. */
  readonly features: readonly RedisFeature[];
  /** The oldest Redis release that accepts every command. */
  readonly minimumRedisVersion: string;
  /** Highest RDB version among `RESTORE` payloads, when there are any. */
  readonly payloadRdbVersion?: number;
  /** Logical databases the dump `SELECT`s, in first-seen order. */
  readonly databases: readonly number[];
}

/** Accumulates {@link DumpRequirements} one command at a time. */
export class RequirementTracker {
  private readonly features = new Set<RedisFeature>();
  private readonly databases: number[] = [];
  private rdbVersion: number | undefined;

  note(command: RedisCommand): void {
    const name = commandName(command);
    for (const feature of featuresOfCommand(command)) {
      this.features.add(feature);
    }
    if (name === 'RESTORE' && command[3] !== undefined) {
      const version = payloadRdbVersion(toBuffer(command[3]));
      if (version !== undefined && (this.rdbVersion === undefined || version > this.rdbVersion)) {
        this.rdbVersion = version;
      }
    }
    if (name === 'SELECT') {
      const database = Number(argumentText(command, 1));
      if (Number.isInteger(database) && !this.databases.includes(database)) {
        this.databases.push(database);
      }
    }
  }

  toRequirements(): DumpRequirements {
    const features = [...this.features].sort();
    let minimum = '2.6.0';
    for (const feature of features) {
      const version = FEATURE_VERSIONS[feature].redis;
      if (!versionAtLeast(minimum, version)) {
        minimum = version;
      }
    }
    return {
      features,
      minimumRedisVersion: minimum,
      ...(this.rdbVersion === undefined ? {} : { payloadRdbVersion: this.rdbVersion }),
      databases: [...this.databases],
    };
  }
}

export interface CompatibilityIssue {
  readonly feature: RedisFeature;
  /** `'unsupported'`: the target certainly rejects it. `'unverified'`: it cannot be determined. */
  readonly status: 'unsupported' | 'unverified';
  readonly message: string;
}

/** Which of a dump's requirements a target server cannot meet. */
export function checkTargetCompatibility(
  requirements: DumpRequirements,
  target: RedisServerVersion,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const label = `${target.flavor === 'valkey' ? 'Valkey' : 'Redis'} ${target.version}`;
  for (const feature of requirements.features) {
    if (feature === 'restore-payload') {
      continue;
    }
    const versions = FEATURE_VERSIONS[feature];
    const needed = target.flavor === 'valkey' ? versions.valkey : versions.redis;
    if (needed === undefined || !versionAtLeast(target.version, needed)) {
      issues.push({
        feature,
        status: 'unsupported',
        message: `${label} does not support ${feature} (needs Redis ${versions.redis}${
          versions.valkey ? ` or Valkey ${versions.valkey}` : ''
        })`,
      });
    }
  }
  if (requirements.payloadRdbVersion !== undefined) {
    const accepted = rdbVersionFor(target);
    if (accepted === undefined) {
      issues.push({
        feature: 'restore-payload',
        status: 'unverified',
        message: `The dump contains RDB version ${requirements.payloadRdbVersion} payloads; which RDB versions ${label} accepts is not known to this package`,
      });
    } else if (requirements.payloadRdbVersion > accepted) {
      issues.push({
        feature: 'restore-payload',
        status: 'unsupported',
        message: `The dump contains RDB version ${requirements.payloadRdbVersion} payloads, but ${label} loads RDB version ${accepted} at most`,
      });
    }
  }
  return issues;
}
