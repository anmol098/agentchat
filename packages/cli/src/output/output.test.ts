import { describe, expect, it } from 'vitest';

import { ANSI_PALETTE, PLAIN_PALETTE } from './colour.js';
import { Logger } from './log.js';
import { Output, view } from './output.js';
import type { OutputStream } from './streams.js';
import { StreamSink } from './streams.js';

/** A descriptor that records what it was given. */
function recorder(): OutputStream & { text: () => string } {
  let text = '';
  return {
    text: () => text,
    write(chunk, callback) {
      text += chunk;
      callback(null);
      return true;
    },
  };
}

/** A view with an obviously different human and machine form. */
const both = view({ count: 2, items: ['a', 'b'] }, (writer) => {
  writer.line('2 items');
});

describe('Output', () => {
  it('writes one complete JSON value per line in JSON mode', async () => {
    const stream = recorder();
    const output = new Output({
      sink: new StreamSink(stream),
      mode: 'json',
      palette: PLAIN_PALETTE,
    });

    await output.emit(both);
    await output.emit(both);

    // NDJSON: one `emit` is one line, so a consumer parses line by line without
    // knowing whether it ran a one-shot command or `listen`.
    expect(stream.text()).toBe('{"count":2,"items":["a","b"]}\n{"count":2,"items":["a","b"]}\n');
  });

  it('never pretty-prints, so a value can never span two lines', async () => {
    const stream = recorder();
    const output = new Output({
      sink: new StreamSink(stream),
      mode: 'json',
      palette: PLAIN_PALETTE,
    });

    await output.emit(view({ nested: { deep: { deeper: [1, 2, 3] } } }, () => undefined));

    expect(stream.text().split('\n').filter(Boolean)).toHaveLength(1);
  });

  it('refuses colour in JSON mode however it was constructed', async () => {
    const stream = recorder();
    const output = new Output({
      sink: new StreamSink(stream),
      mode: 'json',
      palette: ANSI_PALETTE,
    });

    await output.emit(view({ ok: true }, (writer) => writer.line(writer.style.red('no'))));

    expect(stream.text()).toBe('{"ok":true}\n');
  });

  it('writes the human rendering, and only that, in human mode', async () => {
    const stream = recorder();
    const output = new Output({
      sink: new StreamSink(stream),
      mode: 'human',
      palette: PLAIN_PALETTE,
    });

    await output.emit(both);

    expect(stream.text()).toBe('2 items\n');
  });

  it('writes nothing for a view that renders nothing', async () => {
    const stream = recorder();
    const output = new Output({
      sink: new StreamSink(stream),
      mode: 'human',
      palette: PLAIN_PALETTE,
    });

    await output.emit(view({ ok: true }, () => undefined));

    expect(stream.text()).toBe('');
  });
});

describe('Logger', () => {
  it('prefixes every operational line, so a merged log is still readable', () => {
    const stream = recorder();
    const logger = new Logger({
      sink: new StreamSink(stream),
      level: 'info',
      palette: PLAIN_PALETTE,
    });

    logger.info('connected');
    logger.warn('the server is older than this client');

    expect(stream.text()).toBe(
      '[agentchat] connected\n[agentchat] warning: the server is older than this client\n',
    );
  });

  it('drops what the level does not allow', () => {
    const stream = recorder();
    const logger = new Logger({
      sink: new StreamSink(stream),
      level: 'error',
      palette: PLAIN_PALETTE,
    });

    logger.info('progress');
    logger.warn('careful');
    logger.debug('detail');

    expect(stream.text()).toBe('');
  });

  it('reports debug only under --verbose', () => {
    const quiet = recorder();
    const loud = recorder();
    const palette = PLAIN_PALETTE;

    new Logger({ sink: new StreamSink(quiet), level: 'info', palette }).debug('detail');
    new Logger({ sink: new StreamSink(loud), level: 'debug', palette }).debug('detail');

    expect(quiet.text()).toBe('');
    expect(loud.text()).toContain('detail');
    expect(new Logger({ sink: new StreamSink(loud), level: 'debug', palette }).isVerbose).toBe(
      true,
    );
  });

  it('does not fail a command because stderr broke', () => {
    const logger = new Logger({
      sink: new StreamSink({
        write() {
          throw Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
        },
      }),
      level: 'info',
      palette: PLAIN_PALETTE,
    });

    // Nowhere left to report this, and it must not turn a command that worked
    // into one that did not.
    expect(() => {
      logger.info('anything');
    }).not.toThrow();
  });
});
