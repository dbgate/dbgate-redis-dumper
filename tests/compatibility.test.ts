import { describe, expect, it } from 'vitest';
import {
  checkTargetCompatibility,
  featuresOfCommand,
  payloadRdbVersion,
  RequirementTracker,
} from '../src/compatibility/index.js';
import { parseInfo, versionFromInfo } from '../src/version/detect.js';

const server = (info: string) => versionFromInfo(parseInfo(info));

/** A syntactically valid DUMP payload trailer: type byte, RDB version (LE), CRC64. */
function payload(rdbVersion: number): Buffer {
  const out = Buffer.alloc(16);
  out.writeUInt16LE(rdbVersion, out.length - 10);
  return out;
}

describe('command features', () => {
  it('classifies each command by the syntax it uses', () => {
    expect(featuresOfCommand(['HSET', 'h', 'f', 'v'])).toEqual([]);
    expect(featuresOfCommand(['HSET', 'h', 'f', 'v', 'g', 'w'])).toEqual(['multi-field-hset']);
    expect(featuresOfCommand(['XGROUP', 'CREATECONSUMER', 's', 'g', 'c'])).toEqual([
      'streams',
      'xgroup-createconsumer',
    ]);
    expect(featuresOfCommand(['XGROUP', 'CREATE', 's', 'g', '0', 'ENTRIESREAD', 3])).toContain(
      'stream-counters',
    );
    expect(featuresOfCommand(['XSETID', 's', '5-0'])).toEqual(['streams']);
    expect(
      featuresOfCommand(['XSETID', 's', '5-0', 'ENTRIESADDED', 9, 'MAXDELETEDID', '2-0']),
    ).toContain('stream-counters');
    expect(featuresOfCommand(['HPEXPIREAT', 'h', 1, 'FIELDS', 1, 'f'])).toEqual([
      'hash-field-expiration',
    ]);
    expect(featuresOfCommand(['RESTORE', 'k', 5, payload(11), 'REPLACE', 'ABSTTL'])).toEqual([
      'restore-payload',
      'restore-absttl',
    ]);
  });

  it('reads the RDB version from a payload trailer', () => {
    expect(payloadRdbVersion(payload(12))).toBe(12);
    expect(payloadRdbVersion(Buffer.alloc(3))).toBeUndefined();
  });
});

describe('requirements', () => {
  it('accumulates features, the minimum version, payload RDB versions and databases', () => {
    const tracker = new RequirementTracker();
    tracker.note(['SELECT', 0]);
    tracker.note(['SET', 'a', '1']);
    tracker.note(['SELECT', 3]);
    tracker.note(['XGROUP', 'CREATECONSUMER', 's', 'g', 'c']);
    tracker.note(['RESTORE', 'k', 0, payload(10)]);
    tracker.note(['RESTORE', 'k', 0, payload(11)]);
    tracker.note(['SELECT', 0]);
    expect(tracker.toRequirements()).toEqual({
      features: ['restore-payload', 'streams', 'xgroup-createconsumer'],
      minimumRedisVersion: '6.2.0',
      payloadRdbVersion: 11,
      databases: [0, 3],
    });
  });

  it('names exactly what an older target lacks', () => {
    const tracker = new RequirementTracker();
    tracker.note(['XSETID', 's', '5-0', 'ENTRIESADDED', 9, 'MAXDELETEDID', '2-0']);
    tracker.note(['HPEXPIREAT', 'h', 1, 'FIELDS', 1, 'f']);
    tracker.note(['RESTORE', 'k', 0, payload(12)]);
    const requirements = tracker.toRequirements();

    expect(checkTargetCompatibility(requirements, server('redis_version:7.4.2'))).toEqual([]);
    expect(
      checkTargetCompatibility(requirements, server('redis_version:6.2.14')).map(issue => [
        issue.feature,
        issue.status,
      ]),
    ).toEqual([
      ['hash-field-expiration', 'unsupported'],
      ['stream-counters', 'unsupported'],
      ['restore-payload', 'unsupported'],
    ]);
    // Valkey 8 has 7.0's stream counters but not 7.4's hash-field expiration.
    expect(
      checkTargetCompatibility(
        requirements,
        server('redis_version:7.2.4\nvalkey_version:8.0.1'),
      ).map(issue => issue.feature),
    ).toEqual(['hash-field-expiration', 'restore-payload']);
    // An unknown RDB mapping is reported as unverified, never assumed fine.
    expect(checkTargetCompatibility(requirements, server('redis_version:9.1.0'))).toMatchObject([
      { feature: 'restore-payload', status: 'unverified' },
    ]);
  });
});
