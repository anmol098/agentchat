import { describe, expect, it } from 'vitest';

import type { InputStream, OutputStream } from './streams.js';
import { isBrokenPipe, StreamSink, StreamSource } from './streams.js';

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

/**
 * A descriptor that produces exactly these chunks and then closes.
 *
 * @param chunks - What to yield, in order.
 * @returns The stream, and how many times it was asked for another chunk.
 */
function inputOf(...chunks: readonly (string | Uint8Array)[]): InputStream & {
  readonly reads: () => number;
  readonly released: () => boolean;
} {
  let reads = 0;
  let released = false;
  return {
    reads: () => reads,
    released: () => released,
    async *[Symbol.asyncIterator](): AsyncIterator<string | Uint8Array> {
      try {
        for (const chunk of chunks) {
          reads += 1;
          await Promise.resolve();
          yield chunk;
        }
      } finally {
        released = true;
      }
    },
  };
}

/** A descriptor that is open and will never produce anything. */
function silentInput(): InputStream {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<string> => ({
      next: () => new Promise<IteratorResult<string>>(() => undefined),
    }),
  };
}

describe('StreamSource', () => {
  it('reads one line at a time and keeps the rest', async () => {
    const source = new StreamSource(inputOf('yes\nno\n'));

    expect(await source.readLine()).toBe('yes');
    expect(await source.readLine()).toBe('no');
    expect(await source.readLine()).toBeNull();
  });

  it('distinguishes an empty line from end of input', async () => {
    const source = new StreamSource(inputOf('\n'));

    // A person pressing Return, then nobody there at all. A prompt with a
    // default answer has to tell these two apart.
    expect(await source.readLine()).toBe('');
    expect(await source.readLine()).toBeNull();
  });

  it('treats a final line with no newline as a line', async () => {
    const source = new StreamSource(inputOf('y'));

    expect(await source.readLine()).toBe('y');
    expect(await source.readLine()).toBeNull();
  });

  it('strips a carriage return, so `y\\r\\n` is not a third answer', async () => {
    const source = new StreamSource(inputOf('y\r\n'));

    expect(await source.readLine()).toBe('y');
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    const encoded = new TextEncoder().encode('yés\n');
    const source = new StreamSource(inputOf(encoded.slice(0, 2), encoded.slice(2)));

    expect(await source.readLine()).toBe('yés');
  });

  it('reads no more chunks than the line needed', async () => {
    const input = inputOf('y\n', 'unwanted\n');
    const source = new StreamSource(input);

    expect(await source.readLine()).toBe('y');
    expect(input.reads()).toBe(1);
  });

  it('releases the descriptor on close, so the event loop can drain', async () => {
    const input = inputOf('y\n', 'more\n');
    const source = new StreamSource(input);

    await source.readLine();
    await source.close();
    expect(input.released()).toBe(true);

    // Idempotent, and a closed source answers `null` rather than resuming.
    await source.close();
    expect(await source.readLine()).toBeNull();
  });

  it('stops waiting when the signal aborts, and releases the descriptor', async () => {
    const controller = new AbortController();
    const source = new StreamSource(silentInput());

    const pending = source.readLine(controller.signal);
    controller.abort();

    // Without this the read never settles: nothing is going to write to the
    // pipe, which is exactly the `Ctrl-C` at a prompt case.
    expect(await pending).toBeNull();
  });

  it('answers immediately when the signal was already aborted', async () => {
    const source = new StreamSource(silentInput());

    expect(await source.readLine(AbortSignal.abort())).toBeNull();
  });
});
