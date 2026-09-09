import { describe, expect, it } from 'vitest';
import { CloseCode } from './websocket.js';

/**
 * Invariants of the close-code table that no other check covers.
 *
 * Whether it agrees with `docs/protocol.md` §9.6 is asserted twice elsewhere,
 * from either side of the licence boundary — `server/tests/protocol-doc.test.ts`
 * and `packages/client/tests/frames.close-codes.test.ts` — because this package
 * cannot read a file. Whether a code has been removed or renumbered is
 * `pnpm protocol:check`. What is left is the handful of things that are true of
 * the table itself.
 */
describe('CloseCode', () => {
  it('gives every name a distinct number', () => {
    // Both document checks build a `code -> name` map, so a number used twice
    // would silently lose one of its names there rather than fail. A close code
    // is the only part of a close a client can branch on; two meanings sharing
    // one number is a branch that cannot be written.
    const numbers = Object.values(CloseCode);

    expect(new Set(numbers).size, `Two close codes share a number: ${numbers.join(', ')}`).toBe(
      numbers.length,
    );
  });

  it('uses only codes RFC 6455 lets an endpoint send', () => {
    // 1000 and 1011 are the two registered codes this server has a use for;
    // everything else is in the 4000-4999 private-use range of RFC 6455 §7.4.2.
    // 1001 and 1006 are deliberately absent: a browser or a socket library
    // produces those, never this server, so they live in `LocalCloseCode` in
    // packages/client. A number outside these ranges is one an endpoint may not
    // send at all.
    for (const [name, code] of Object.entries(CloseCode)) {
      expect(
        code === 1000 || code === 1011 || (code >= 4000 && code <= 4999),
        `CloseCode.${name} is ${code}, which is neither one of the two registered codes this server sends nor in RFC 6455's 4000-4999 private-use range.`,
      ).toBe(true);
    }
  });

  it('is frozen, so a consumer cannot mutate the vocabulary it was handed', () => {
    expect(Object.isFrozen(CloseCode)).toBe(true);
  });
});
