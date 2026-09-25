import type { RedisConnection } from '../connection/types.js';
import { replyToString } from '../protocol/replies.js';
import { RedisDumperError } from '../utils/errors.js';
import type { RedisServerCapabilities, RedisServerFlavor, RedisServerVersion } from './types.js';

/** The oldest source this package dumps: streams, and `RESTORE ... ABSTTL`, arrived in 5.0. */
export const MINIMUM_SUPPORTED_VERSION = '5.0.0';

/** Parses `INFO` text into `field → value`, ignoring `# Section` headers. */
export function parseInfo(text: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const colon = line.indexOf(':');
    if (colon > 0) {
      fields.set(line.slice(0, colon), line.slice(colon + 1));
    }
  }
  return fields;
}

/** Parses `INFO keyspace` into `database → key count`. */
export function parseKeyspace(text: string): Map<number, number> {
  const databases = new Map<number, number>();
  for (const [field, value] of parseInfo(text)) {
    const database = /^db(\d+)$/.exec(field);
    const keys = /(?:^|,)keys=(\d+)/.exec(value);
    if (database && keys) {
      databases.set(Number(database[1]), Number(keys[1]));
    }
  }
  return databases;
}

function parseTriple(version: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = version
    .split('.')
    .map(part => Number.parseInt(part, 10))
    .map(value => (Number.isFinite(value) ? value : 0));
  return [major, minor, patch];
}

/** `-1`, `0` or `1`, comparing dotted versions numerically (`7.10` > `7.9`). */
export function compareVersions(left: string, right: string): number {
  const a = parseTriple(left);
  const b = parseTriple(right);
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] as number) - (b[index] as number);
    if (difference !== 0) {
      return difference < 0 ? -1 : 1;
    }
  }
  return 0;
}

export function versionAtLeast(version: string, minimum: string): boolean {
  return compareVersions(version, minimum) >= 0;
}

/** Builds a {@link RedisServerVersion} from parsed `INFO server` fields. */
export function versionFromInfo(fields: ReadonlyMap<string, string>): RedisServerVersion {
  const redisVersion = fields.get('redis_version');
  const valkeyVersion = fields.get('valkey_version');
  const flavor: RedisServerFlavor =
    valkeyVersion !== undefined || fields.get('server_name') === 'valkey' ? 'valkey' : 'redis';
  const version = (flavor === 'valkey' ? valkeyVersion : redisVersion) ?? redisVersion;
  if (!version) {
    throw new RedisDumperError(
      'version-undetectable',
      'The server did not report redis_version in INFO server',
    );
  }
  const [major, minor, patch] = parseTriple(version);
  return {
    flavor,
    version,
    major,
    minor,
    patch,
    redisCompatibleVersion: redisVersion ?? version,
    mode: fields.get('redis_mode') ?? 'standalone',
  };
}

/** Reads `INFO server` and returns the server's flavor, version and mode. */
export async function detectServerVersion(
  connection: RedisConnection,
  signal?: AbortSignal,
): Promise<RedisServerVersion> {
  const reply = await connection.call(['INFO', 'server'], signal);
  return versionFromInfo(parseInfo(replyToString(reply)));
}

/** Derives the capability flags from a detected version. */
export function capabilitiesFor(server: RedisServerVersion): RedisServerCapabilities {
  const compatible = server.redisCompatibleVersion;
  return {
    scanType: versionAtLeast(compatible, '6.0.0'),
    pexpireTime: versionAtLeast(compatible, '7.0.0'),
    clientInfo: versionAtLeast(compatible, '6.2.0'),
    xgroupCreateConsumer: versionAtLeast(compatible, '6.2.0'),
    streamCounters: versionAtLeast(compatible, '7.0.0'),
    hashFieldExpiration:
      server.flavor === 'valkey'
        ? versionAtLeast(server.version, '9.0.0')
        : versionAtLeast(server.version, '7.4.0'),
  };
}

/**
 * The newest RDB serialization version a server can load, which bounds the
 * `DUMP` payloads its `RESTORE` accepts. `undefined` where the mapping is not
 * known, in which case callers must treat compatibility as unverified rather
 * than assume it.
 */
export function rdbVersionFor(server: RedisServerVersion): number | undefined {
  if (server.flavor === 'valkey') {
    return server.major >= 7 && server.major < 9 ? 11 : undefined;
  }
  if (server.major === 5 || server.major === 6) {
    return 9;
  }
  if (server.major === 7) {
    if (server.minor === 0) return 10;
    if (server.minor === 2) return 11;
    if (server.minor >= 4) return 12;
  }
  if (server.major === 8) {
    return 12;
  }
  return undefined;
}
