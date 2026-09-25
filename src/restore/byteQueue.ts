/**
 * A FIFO of bytes held as the chunks they arrived in.
 *
 * A single Redis value can be hundreds of megabytes, arriving as thousands
 * of small stream chunks. Concatenating on every chunk would make parsing
 * it quadratic; this queue only copies bytes when a complete token is taken
 * out, and searches resume where the previous search stopped.
 */
export class ByteQueue {
  private chunks: Buffer[] = [];
  /** Bytes of `chunks[0]` already consumed. */
  private head = 0;
  private size = 0;

  get length(): number {
    return this.size;
  }

  push(chunk: Buffer): void {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.size += chunk.length;
    }
  }

  /** The byte at `index` (relative to the front), or `undefined` past the end. */
  byteAt(index: number): number | undefined {
    if (index < 0 || index >= this.size) {
      return undefined;
    }
    let remaining = index + this.head;
    for (const chunk of this.chunks) {
      if (remaining < chunk.length) {
        return chunk[remaining];
      }
      remaining -= chunk.length;
    }
    return undefined;
  }

  /** Position of the first `byte` at or after `from`, or `-1`. */
  indexOf(byte: number, from = 0): number {
    let base = 0;
    let first = true;
    for (const chunk of this.chunks) {
      const start = first ? this.head : 0;
      const available = chunk.length - start;
      first = false;
      if (from >= base + available) {
        base += available;
        continue;
      }
      const found = chunk.indexOf(byte, start + Math.max(0, from - base));
      if (found !== -1) {
        return base + (found - start);
      }
      base += available;
    }
    return -1;
  }

  /** Removes and returns the first `count` bytes. */
  take(count: number): Buffer {
    if (count > this.size) {
      throw new RangeError(`Cannot take ${count} bytes from a queue of ${this.size}`);
    }
    const first = this.chunks[0];
    if (first && first.length - this.head >= count) {
      const out = first.subarray(this.head, this.head + count);
      this.skip(count);
      return out;
    }
    const out = Buffer.allocUnsafe(count);
    let written = 0;
    while (written < count) {
      const chunk = this.chunks[0] as Buffer;
      const piece = Math.min(chunk.length - this.head, count - written);
      chunk.copy(out, written, this.head, this.head + piece);
      written += piece;
      this.skip(piece);
    }
    return out;
  }

  /** Discards the first `count` bytes. */
  skip(count: number): void {
    let remaining = count;
    this.size -= count;
    while (remaining > 0) {
      const chunk = this.chunks[0] as Buffer;
      const available = chunk.length - this.head;
      if (remaining < available) {
        this.head += remaining;
        return;
      }
      remaining -= available;
      this.chunks.shift();
      this.head = 0;
    }
  }
}
