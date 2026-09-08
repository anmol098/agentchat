import { describe, expect, it } from 'vitest';

import type { OutputStream } from './streams.js';
import { isBrokenPipe, StreamSink } from './streams.js';

/** A stream whose write completes on the next tick, as a real pipe's does. */
function asyncStream(): OutputStream & { written: string[] } {
  const written: string[] = [];
  return {
    written,
    write(chunk, callback) {
      written.push(chunk);
      queueMicrotask(() => {
        callback(null);
      });
      return true;
    },
  };
}

/** An `EPIPE`, shaped the way Node produces it. */
function brokenPipe(): NodeJS.ErrnoException {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
}

describe('isBrokenPipe', () => {
  it('recognises EPIPE and nothing else', () => {
    expect(isBrokenPipe(brokenPipe())).toBe(true);
    expect(isBrokenPipe(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe(false);
    expect(isBrokenPipe(new Error('x'))).toBe(false);
    expect(isBrokenPipe(null)).toBe(false);
    expect(isBrokenPipe('EPIPE')).toBe(false);
  });
});

describe('StreamSink', () => {
  it('resolves only after the write has been flushed', async () => {
    // The guarantee plan §6.3 depends on: `listen` acknowledges a message after
    // it has reached stdout, so a harness whose pipe died never loses one.
    const stream = asyncStream();
    const sink = new StreamSink(stream);
    let flushed = false;

    const write = sink.write('hello\n').then(() => {
      flushed = true;
    });

    expect(flushed).toBe(false);
    await write;
    expect(flushed).toBe(true);
    expect(stream.written).toEqual(['hello\n']);
  });

  it('writes nothing for the empty string', async () => {
    const stream = asyncStream();

    await new StreamSink(stream).write('');

    expect(stream.written).toEqual([]);
  });

  it('marks itself closed on EPIPE and stops writing', async () => {
    const attempts: string[] = [];
    const sink = new StreamSink({
      write(chunk, callback) {
        attempts.push(chunk);
        callback(brokenPipe());
        return false;
      },
    });

    await expect(sink.write('first\n')).rejects.toThrow(/EPIPE/);
    expect(sink.closed).toBe(true);

    // The reader is gone; a second write would be a second pointless syscall
    // and a second rejection for the caller to handle.
    await sink.write('second\n');
    expect(attempts).toEqual(['first\n']);
  });

  it('survives a stream that throws synchronously once the descriptor is gone', async () => {
    const sink = new StreamSink({
      write() {
        throw brokenPipe();
      },
    });

    await expect(sink.write('x')).rejects.toThrow(/EPIPE/);
    expect(sink.closed).toBe(true);
  });

  it('reports isTTY only when the stream says so', () => {
    expect(new StreamSink({ ...asyncStream(), isTTY: true }).isTTY).toBe(true);
    expect(new StreamSink(asyncStream()).isTTY).toBe(false);
  });
});
