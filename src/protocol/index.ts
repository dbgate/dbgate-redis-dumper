import type { RedisCommand } from '../connection/types.js';
import { encodeRespCommand } from './respEncoding.js';
import type { TextEncodingOptions } from './textEncoding.js';
import { encodeTextCommand } from './textEncoding.js';

export * from './arguments.js';
export * from './replies.js';
export * from './textEncoding.js';
export * from './respEncoding.js';

/**
 * The two on-disk encodings of a dump. Both carry the same commands.
 *
 * - `'text'`: one `redis-cli` command per line. Restores with
 *   `redis-cli < dump.redis`; readable and diffable.
 * - `'resp'`: RESP2 protocol. Restores with `redis-cli --pipe < dump.resp`,
 *   Redis's own mass-insertion path, which is much faster for large dumps.
 */
export type DumpFormat = 'text' | 'resp';

export function encodeCommand(
  command: RedisCommand,
  format: DumpFormat,
  options: TextEncodingOptions = {},
): Buffer {
  return format === 'resp' ? encodeRespCommand(command) : encodeTextCommand(command, options);
}
