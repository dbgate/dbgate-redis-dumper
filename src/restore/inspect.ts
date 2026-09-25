import type { DumpRequirements } from '../compatibility/index.js';
import { RequirementTracker } from '../compatibility/index.js';
import { commandName } from '../protocol/arguments.js';
import { RESTORE_COMMANDS } from '../security/index.js';
import type { CommandParserOptions } from './parser.js';
import { CommandParser, RedisDumpParseError, streamRedisCommands } from './parser.js';
import type { RedisDumpSource } from './source.js';

export interface DumpAnalysis {
  readonly format: 'text' | 'resp';
  readonly commands: number;
  readonly bytes: number;
  /** Commands per name, e.g. `{ SET: 120, HSET: 40 }`. */
  readonly commandCounts: Readonly<Record<string, number>>;
  /** Command names outside the default restore allow-list, which a default restore refuses. */
  readonly refusedByDefault: readonly string[];
  readonly requirements: DumpRequirements;
}

/**
 * Reads a whole dump without executing anything, and reports what it
 * contains and what a restore target will need. Streams, so it works on
 * dumps of any size.
 */
export async function analyzeRedisDump(
  source: RedisDumpSource,
  options: CommandParserOptions = {},
): Promise<DumpAnalysis> {
  const parser = new CommandParser(options);
  const tracker = new RequirementTracker();
  const counts: Record<string, number> = {};
  let commands = 0;
  for await (const parsed of streamRedisCommands(source, options, parser)) {
    tracker.note(parsed.argv);
    const name = commandName(parsed.argv);
    counts[name] = (counts[name] ?? 0) + 1;
    commands++;
  }
  return {
    format: parser.detectedFormat ?? 'text',
    commands,
    bytes: parser.bytesConsumed,
    commandCounts: counts,
    refusedByDefault: Object.keys(counts)
      .filter(name => !RESTORE_COMMANDS.has(name))
      .sort(),
    requirements: tracker.toRequirements(),
  };
}

/**
 * Detects a dump's encoding from its first bytes: `'resp'`, `'text'`, or
 * `undefined` when the sample is empty or whitespace.
 */
export function detectDumpFormat(sample: string | Buffer): 'text' | 'resp' | undefined {
  const bytes = typeof sample === 'string' ? Buffer.from(sample, 'utf8') : sample;
  for (const byte of bytes) {
    if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) {
      return byte === 0x2a ? 'resp' : 'text';
    }
  }
  return undefined;
}

/**
 * True when `sample` — the first few kilobytes of a file — looks like a
 * Redis command script: it parses, and its first complete commands are
 * ones a restore would run. Recognizes this package's dumps in both
 * formats as well as hand-written `redis-cli` scripts and RESP
 * mass-insertion files.
 */
export function isRedisDump(sample: string | Buffer): boolean {
  const bytes = typeof sample === 'string' ? Buffer.from(sample, 'utf8') : sample;
  const parser = new CommandParser();
  try {
    // Only complete commands count: the sample may end mid-command.
    const commands = parser.push(bytes).slice(0, 5);
    return (
      commands.length > 0 &&
      commands.every(command => RESTORE_COMMANDS.has(commandName(command.argv)))
    );
  } catch (error) {
    if (error instanceof RedisDumpParseError) {
      return false;
    }
    throw error;
  }
}
