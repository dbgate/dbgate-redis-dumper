import { PassThrough, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { BufferDumpWriter } from '../src/writer/bufferWriter.js';
import { StreamDumpWriter } from '../src/writer/streamWriter.js';

describe('BufferDumpWriter', () => {
  it('counts bytes, not characters', async () => {
    const writer = new BufferDumpWriter();
    await writer.write('é😀');
    expect(writer.bytesWritten).toBe(Buffer.byteLength('é😀', 'utf8'));
  });

  it('keeps raw bytes intact', async () => {
    const writer = new BufferDumpWriter();
    const bytes = Buffer.from([0xff, 0x00, 0xfe]);
    await writer.write(bytes);
    expect(writer.toBuffer()).toEqual(bytes);
  });

  it('mixes text and bytes in order', async () => {
    const writer = new BufferDumpWriter();
    await writer.write('$1\r\n');
    await writer.write(Buffer.from([0xff]));
    await writer.write('\r\n');
    expect(writer.toBuffer().toString('latin1')).toBe(`$1\r\n${String.fromCharCode(0xff)}\r\n`);
  });

  it('refuses to write once aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(new BufferDumpWriter().write('x', controller.signal)).rejects.toThrow();
  });
});

describe('StreamDumpWriter', () => {
  it('writes text and bytes to the underlying stream', async () => {
    const chunks: Buffer[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const writer = new StreamDumpWriter(stream);
    await writer.write('text ');
    await writer.write(Buffer.from([0xff]));
    expect(Buffer.concat(chunks).toString('latin1')).toBe(`text ${String.fromCharCode(0xff)}`);
    expect(writer.bytesWritten).toBe(6);
  });

  it('never ends the caller-owned stream', async () => {
    let ended = false;
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      final(callback) {
        ended = true;
        callback();
      },
    });
    const writer = new StreamDumpWriter(stream);
    await writer.write('x');
    expect(ended).toBe(false);
  });

  it('surfaces a stream error rather than swallowing it', async () => {
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error('disk full'));
      },
    });
    stream.on('error', () => {});
    const writer = new StreamDumpWriter(stream);
    // Surfaced on the failing write itself when the stream reports
    // synchronously, and on the next one otherwise — either way it is never
    // swallowed, which is what matters for a dump that must not look complete.
    await expect(writer.write('first').then(() => writer.write('second'))).rejects.toThrow(
      'disk full',
    );
  });

  it('waits for drain instead of buffering without limit', async () => {
    // A tiny high-water mark makes `write()` return false immediately.
    const stream = new PassThrough({ highWaterMark: 1 });
    const writer = new StreamDumpWriter(stream);
    let resolved = false;
    const pending = writer.write('x'.repeat(64)).then(() => {
      resolved = true;
    });
    // Nothing consumed yet, so the write is still parked on `drain`.
    expect(resolved).toBe(false);
    stream.resume();
    await pending;
    expect(resolved).toBe(true);
  });

  it('does not stall forever when a cancelled write is waiting on drain', async () => {
    const controller = new AbortController();
    const stream = new PassThrough({ highWaterMark: 1 });
    const writer = new StreamDumpWriter(stream);
    const pending = writer.write('x'.repeat(64), controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('ignores an empty chunk', async () => {
    const writer = new StreamDumpWriter(new PassThrough());
    await writer.write('');
    expect(writer.bytesWritten).toBe(0);
  });
});
