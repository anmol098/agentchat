import { ErrorCode, MessageId } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import { DEFAULT_SEEN_CAPACITY, SeenMessages } from './dedupe.js';

/** A fresh, valid message identifier. */
function id(): MessageId {
  return MessageId.generate();
}

describe('SeenMessages', () => {
  it('admits an identifier once and refuses it afterwards', () => {
    const seen = new SeenMessages();
    const messageId = id();

    expect(seen.admit(messageId)).toBe(true);
    expect(seen.admit(messageId)).toBe(false);
    expect(seen.admit(messageId)).toBe(false);
  });

  it('admits distinct identifiers independently', () => {
    const seen = new SeenMessages();

    expect(seen.admit(id())).toBe(true);
    expect(seen.admit(id())).toBe(true);
    expect(seen.size).toBe(2);
  });

  it('never grows past its capacity', () => {
    const seen = new SeenMessages(8);

    for (let index = 0; index < 1_000; index += 1) {
      seen.admit(id());
    }

    // The bound is the whole point: a listener that runs for a month must use
    // the same memory on its last message as on its first.
    expect(seen.size).toBe(8);
  });

  it('evicts the oldest sighting first', () => {
    const seen = new SeenMessages(2);
    const first = id();
    const second = id();
    const third = id();

    seen.admit(first);
    seen.admit(second);
    seen.admit(third);

    expect(seen.has(first)).toBe(false);
    expect(seen.has(second)).toBe(true);
    expect(seen.has(third)).toBe(true);
  });

  it('does not extend an identifier’s life by re-seeing it', () => {
    // First-in-first-out by first sighting, not least-recently-used. An LRU
    // would keep a never-acknowledged message suppressed forever by the very
    // replays it is supposed to be dropping.
    const seen = new SeenMessages(2);
    const first = id();
    const second = id();

    seen.admit(first);
    seen.admit(second);
    seen.admit(first);
    seen.admit(id());

    expect(seen.has(first)).toBe(false);
  });

  it('keeps a duplicate suppressed across the reconnect it is meant to span', () => {
    // The realistic shape: one message delivered, its acknowledgement lost, the
    // socket dropped, and the same message replayed at the head of the next
    // connection with nothing in between.
    const seen = new SeenMessages(DEFAULT_SEEN_CAPACITY);
    const lost = id();

    expect(seen.admit(lost)).toBe(true);
    for (let index = 0; index < 100; index += 1) {
      seen.admit(id());
    }

    expect(seen.admit(lost)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses a capacity of %s', (capacity) => {
    expect(() => new SeenMessages(capacity)).toThrowError(
      expect.objectContaining({ code: ErrorCode.BAD_REQUEST }),
    );
  });
});
