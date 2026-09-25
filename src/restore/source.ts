import { Readable } from 'node:stream';

/** Anything a restore can read a dump from. */
export type RedisDumpSource =
  | string
  | Buffer
  | Uint8Array
  | Readable
  | AsyncIterable<string | Buffer | Uint8Array>
  | Iterable<string | Buffer | Uint8Array>;

function toChunk(chunk: string | Buffer | Uint8Array): Buffer {
  if (typeof chunk === 'string') {
    return Buffer.from(chunk, 'utf8');
  }
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

/** Normalizes any {@link RedisDumpSource} into an async sequence of `Buffer` chunks. */
export async function* readSource(source: RedisDumpSource): AsyncGenerator<Buffer> {
  if (typeof source === 'string' || source instanceof Uint8Array) {
    yield toChunk(source);
    return;
  }
  if (source instanceof Readable || Symbol.asyncIterator in source) {
    for await (const chunk of source as AsyncIterable<string | Buffer | Uint8Array>) {
      yield toChunk(chunk);
    }
    return;
  }
  for (const chunk of source as Iterable<string | Buffer | Uint8Array>) {
    yield toChunk(chunk);
  }
}
