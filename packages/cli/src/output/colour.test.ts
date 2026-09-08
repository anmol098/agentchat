import { describe, expect, it } from 'vitest';

import { ANSI_PALETTE, colourEnabled, PLAIN_PALETTE, paletteFor } from './colour.js';

/** The default: a pipe, an unremarkable environment. */
const piped = { isTTY: false, env: {} };
const terminal = { isTTY: true, env: {} };

describe('colourEnabled', () => {
  it('is off when the stream is not a terminal', () => {
    // The case that matters. Every capture, every pipe, every redirect to a
    // file: an ANSI escape in any of them breaks an equality assertion, a grep,
    // and a JSON parser alike.
    expect(colourEnabled(piped)).toBe(false);
  });

  it('is on for a terminal', () => {
    expect(colourEnabled(terminal)).toBe(true);
  });

  it('lets an explicit flag beat every environment signal', () => {
    expect(colourEnabled({ ...piped, forced: true })).toBe(true);
    expect(colourEnabled({ ...terminal, forced: false })).toBe(false);
    expect(colourEnabled({ isTTY: true, env: { NO_COLOR: '1' }, forced: true })).toBe(true);
  });

  it('honours NO_COLOR over FORCE_COLOR', () => {
    expect(colourEnabled({ isTTY: false, env: { NO_COLOR: '1', FORCE_COLOR: '1' } })).toBe(false);
  });

  it('ignores an empty NO_COLOR, as no-color.org specifies', () => {
    expect(colourEnabled({ isTTY: true, env: { NO_COLOR: '' } })).toBe(true);
  });

  it('honours FORCE_COLOR on a pipe, except for the documented 0', () => {
    expect(colourEnabled({ isTTY: false, env: { FORCE_COLOR: '1' } })).toBe(true);
    expect(colourEnabled({ isTTY: false, env: { FORCE_COLOR: '0' } })).toBe(false);
  });

  it('is off for TERM=dumb', () => {
    expect(colourEnabled({ isTTY: true, env: { TERM: 'dumb' } })).toBe(false);
  });
});

describe('paletteFor', () => {
  it('returns styles that are the identity when colour is off', () => {
    const palette = paletteFor(false);

    expect(palette).toBe(PLAIN_PALETTE);
    for (const style of Object.values(palette)) {
      expect(style('text')).toBe('text');
    }
  });

  it('closes each attribute specifically, so nesting survives', () => {
    // `bold(red(x))` with a generic reset would lose the bold at the inner
    // close. Each style resets only its own attribute.
    const nested = ANSI_PALETTE.bold(ANSI_PALETTE.red('x'));

    expect(nested).toBe('[1m[31mx[39m[22m');
  });
});
