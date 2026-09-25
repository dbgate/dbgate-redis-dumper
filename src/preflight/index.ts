import type { CompatibilityIssue, DumpRequirements } from '../compatibility/index.js';
import { checkTargetCompatibility } from '../compatibility/index.js';
import { acquireRedisConnection } from '../connection/acquire.js';
import type { RedisConnectionInput } from '../connection/types.js';
import { replyToString } from '../protocol/replies.js';
import { detectServerVersion, parseKeyspace } from '../version/detect.js';
import type { RedisServerVersion } from '../version/types.js';

export interface PreflightRestoreRequest {
  readonly connection: RedisConnectionInput;
  /** From `DumpResult.requirements` or `analyzeRedisDump(...).requirements`. */
  readonly requirements: DumpRequirements;
  readonly signal?: AbortSignal;
}

export interface PreflightRestoreResult {
  readonly server: RedisServerVersion;
  /** `false` when some requirement is certainly unsupported. */
  readonly compatible: boolean;
  readonly issues: readonly CompatibilityIssue[];
  /**
   * Target databases that already hold keys, among those the dump writes
   * to (or every non-empty database, for a dump without `SELECT`s). A restore
   * replaces keys of the same name and leaves the others in place.
   */
  readonly nonEmptyDatabases: readonly { readonly database: number; readonly keys: number }[];
}

/**
 * Checks, without writing anything, whether a target server can take a
 * dump: its version against every feature the dump uses, the RDB version
 * of any `RESTORE` payloads, and which of the databases it would write to
 * already hold data.
 */
export async function preflightRestore(
  request: PreflightRestoreRequest,
): Promise<PreflightRestoreResult> {
  const acquired = await acquireRedisConnection(request.connection, request.signal);
  try {
    const { connection } = acquired;
    const server = await detectServerVersion(connection, request.signal);
    const issues = checkTargetCompatibility(request.requirements, server);
    const keyspace = parseKeyspace(
      replyToString(await connection.call(['INFO', 'keyspace'], request.signal)),
    );
    const written = request.requirements.databases;
    const nonEmptyDatabases = [...keyspace.entries()]
      .filter(
        ([database, keys]) => keys > 0 && (written.length === 0 || written.includes(database)),
      )
      .map(([database, keys]) => ({ database, keys }));
    return {
      server,
      compatible: !issues.some(issue => issue.status === 'unsupported'),
      issues,
      nonEmptyDatabases,
    };
  } finally {
    await acquired.release();
  }
}
