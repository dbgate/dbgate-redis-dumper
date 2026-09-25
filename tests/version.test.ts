import { describe, expect, it } from 'vitest';
import {
  capabilitiesFor,
  compareVersions,
  parseInfo,
  parseKeyspace,
  rdbVersionFor,
  versionFromInfo,
} from '../src/version/detect.js';

const fromInfo = (text: string) => versionFromInfo(parseInfo(text));

describe('version detection', () => {
  it('reads Redis from INFO server', () => {
    const server = fromInfo('# Server\r\nredis_version:7.2.5\r\nredis_mode:standalone\r\n');
    expect(server).toMatchObject({
      flavor: 'redis',
      version: '7.2.5',
      major: 7,
      minor: 2,
      patch: 5,
    });
  });

  it('recognizes Valkey, which reports a frozen redis_version', () => {
    const server = fromInfo('redis_version:7.2.4\nserver_name:valkey\nvalkey_version:8.0.1\n');
    expect(server).toMatchObject({
      flavor: 'valkey',
      version: '8.0.1',
      redisCompatibleVersion: '7.2.4',
    });
  });

  it('reports cluster and sentinel mode', () => {
    expect(fromInfo('redis_version:7.0.0\nredis_mode:cluster\n').mode).toBe('cluster');
  });

  it('refuses a reply without a version', () => {
    expect(() => fromInfo('# Server\n')).toThrow('redis_version');
  });

  it('compares versions numerically', () => {
    expect(compareVersions('7.10.0', '7.9.9')).toBe(1);
    expect(compareVersions('6.2', '6.2.0')).toBe(0);
    expect(compareVersions('5.0.14', '6.0.0')).toBe(-1);
  });

  it('parses INFO keyspace', () => {
    const keyspace = parseKeyspace(
      '# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=0\r\ndb12:keys=40,expires=0,avg_ttl=0\r\n',
    );
    expect([...keyspace]).toEqual([
      [0, 3],
      [12, 40],
    ]);
  });
});

describe('capabilities', () => {
  it('gates each feature on the release that introduced it', () => {
    expect(capabilitiesFor(fromInfo('redis_version:5.0.14'))).toEqual({
      scanType: false,
      pexpireTime: false,
      clientInfo: false,
      xgroupCreateConsumer: false,
      streamCounters: false,
      hashFieldExpiration: false,
    });
    expect(capabilitiesFor(fromInfo('redis_version:7.4.0'))).toEqual({
      scanType: true,
      pexpireTime: true,
      clientInfo: true,
      xgroupCreateConsumer: true,
      streamCounters: true,
      hashFieldExpiration: true,
    });
  });

  it('uses the Valkey version for features Valkey added on its own', () => {
    const valkey8 = capabilitiesFor(fromInfo('redis_version:7.2.4\nvalkey_version:8.0.1'));
    expect(valkey8.streamCounters).toBe(true);
    expect(valkey8.hashFieldExpiration).toBe(false);
    expect(
      capabilitiesFor(fromInfo('redis_version:7.2.4\nvalkey_version:9.0.0')).hashFieldExpiration,
    ).toBe(true);
  });

  it('knows which RDB version a server loads, and admits when it does not', () => {
    expect(rdbVersionFor(fromInfo('redis_version:6.2.14'))).toBe(9);
    expect(rdbVersionFor(fromInfo('redis_version:7.0.15'))).toBe(10);
    expect(rdbVersionFor(fromInfo('redis_version:7.2.5'))).toBe(11);
    expect(rdbVersionFor(fromInfo('redis_version:7.4.1'))).toBe(12);
    expect(rdbVersionFor(fromInfo('redis_version:9.0.0'))).toBeUndefined();
  });
});
