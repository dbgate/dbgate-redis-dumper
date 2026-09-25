import type { DumpRedisOptions, DumpResult } from '../../src/api/types.js';
import { dumpRedis } from '../../src/api/dump.js';
import type { RedisConnectionInput } from '../../src/connection/types.js';
import { BufferDumpWriter } from '../../src/writer/bufferWriter.js';

/** Dumps into memory and returns the bytes with the result. */
export async function dumpToBuffer(
  connection: RedisConnectionInput,
  options: DumpRedisOptions = {},
): Promise<{ bytes: Buffer; result: DumpResult }> {
  const writer = new BufferDumpWriter();
  const result = await dumpRedis(connection, options, writer);
  return { bytes: writer.toBuffer(), result };
}
