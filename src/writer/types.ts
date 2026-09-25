/**
 * Incremental output sink for rendered dump text.
 *
 * `write` accepts a `Buffer` as well as a `string` because a Redis dump is
 * not necessarily valid UTF-8: the `resp` format carries every key and value
 * as its raw bytes, exactly as the server stored them. Routing those bytes
 * through a JavaScript string would replace every invalid UTF-8 sequence
 * with U+FFFD and silently corrupt the data, so the encoders hand the writer
 * a `Buffer` instead.
 *
 * Implementations never close the underlying resource; callers own its
 * lifecycle.
 */
export interface DumpWriter {
  /** Writes one chunk, resolving once it is safe to write again (respects backpressure). */
  write(chunk: string | Buffer, signal?: AbortSignal): Promise<void>;
  /** Total bytes written so far. */
  readonly bytesWritten: number;
}
