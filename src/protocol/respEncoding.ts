import type { RedisCommand } from '../connection/types.js';
import { toBuffer } from './arguments.js';

/**
 * The `resp` dump format: every command as a RESP2 array of bulk strings —
 * byte for byte what a client sends a server.
 *
 * This is Redis's documented mass-insertion format, the one
 * `redis-cli --pipe < dump.resp` forwards to the server unchanged. Every
 * argument carries an explicit length, so it is binary-safe without any
 * escaping and parses in a single pass.
 */
export function encodeRespCommand(command: RedisCommand): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${command.length}\r\n`, 'latin1')];
  for (const argument of command) {
    const bytes = toBuffer(argument);
    parts.push(Buffer.from(`$${bytes.length}\r\n`, 'latin1'), bytes, CRLF);
  }
  return Buffer.concat(parts);
}

const CRLF = Buffer.from('\r\n', 'latin1');
