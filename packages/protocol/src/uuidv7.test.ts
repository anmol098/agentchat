import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProtocolError } from './errors.js';
import { isUuidv7, uuidv7, uuidv7Timestamp } from './uuidv7.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('uuidv7', () => {
  it('produces the canonical lowercase hyphenated form', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(id).toHaveLength(36);
    expect(isUuidv7(id)).toBe(true);
  });

  it('sets the version and variant bits required by RFC 9562', () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const bytes = uuidv7().replaceAll('-', '');
      // Version nibble: byte 6, high nibble.
      expect(bytes.slice(12, 13)).toBe('7');
      // Variant: byte 8, top two bits are 0b10.
      const variantByte = Number.parseInt(bytes.slice(16, 18), 16);
      expect(variantByte & 0b1100_0000).toBe(0b1000_0000);
    }
  });

  it('embeds the current time', () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const embedded = uuidv7Timestamp(id);
    expect(embedded).toBeGreaterThanOrEqual(before);
    expect(embedded).toBeLessThanOrEqual(after);
  });

  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7()));
    expect(ids.size).toBe(10_000);
  });

  it('is strictly increasing as a string, past counter exhaustion', () => {
    // 50k ids in far fewer than 50k milliseconds, so this exercises the
    // same-millisecond counter and, at 4096 ids per millisecond, its overflow.
    const ids = Array.from({ length: 50_000 }, () => uuidv7());
    for (let index = 1; index < ids.length; index += 1) {
      expect(String(ids[index - 1]) < String(ids[index])).toBe(true);
    }
  });

  it('stays increasing when the clock steps backwards', () => {
    uuidv7();
    vi.spyOn(Date, 'now').mockReturnValue(0);
    const ids = Array.from({ length: 100 }, () => uuidv7());
    for (let index = 1; index < ids.length; index += 1) {
      expect(String(ids[index - 1]) < String(ids[index])).toBe(true);
    }
    // The frozen timestamp is the last real one, not the rewound clock.
    expect(uuidv7Timestamp(String(ids[0]))).toBeGreaterThan(0);
  });
});

describe('isUuidv7', () => {
  it('accepts a generated id', () => {
    expect(isUuidv7(uuidv7())).toBe(true);
  });

  it.each([
    ['uppercase', '018F6B1A-9C2E-7F3A-8B4D-5E6F70819A2B'],
    ['a v4 uuid', '9f1e2d3c-4b5a-4c7d-8e9f-0a1b2c3d4e5f'],
    ['a v1 uuid', '9f1e2d3c-4b5a-1c7d-8e9f-0a1b2c3d4e5f'],
    ['a reserved variant', '018f6b1a-9c2e-7f3a-cb4d-5e6f70819a2b'],
    ['unhyphenated', '018f6b1a9c2e7f3a8b4d5e6f70819a2b'],
    ['braced', '{018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b}'],
    ['padded', ' 018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b '],
    ['truncated', '018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2'],
    ['empty', ''],
  ])('rejects %s', (_label, value) => {
    expect(isUuidv7(value)).toBe(false);
  });

  it.each([[null], [undefined], [42], [{}], [['018f6b1a']]])(
    'rejects the non-string %s',
    (value) => {
      expect(isUuidv7(value)).toBe(false);
    },
  );
});

describe('uuidv7Timestamp', () => {
  it('decodes a known timestamp', () => {
    // 0x018f6b1a9c2e = 1_714_766_768_686 ms.
    expect(uuidv7Timestamp('018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b')).toBe(0x018f_6b1a_9c2e);
  });

  it('round-trips through generation', () => {
    const id = uuidv7();
    expect(uuidv7Timestamp(id)).toBeLessThanOrEqual(Date.now());
  });

  it('rejects anything that is not a canonical UUIDv7', () => {
    expect(() => uuidv7Timestamp('nope')).toThrow(ProtocolError);
    try {
      uuidv7Timestamp('018F6B1A-9C2E-7F3A-8B4D-5E6F70819A2B');
      expect.unreachable('uppercase must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe('BAD_REQUEST');
    }
  });
});
