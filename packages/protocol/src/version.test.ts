import { describe, expect, it } from 'vitest';

import { MIN_CLIENT_VERSION, PROTOCOL_VERSION } from './version.js';

describe('PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    // Plan §12.4 calls for an integer, not a semver string: it names the shape
    // of the conversation, and only a non-additive change moves it.
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });

  // Moved to 2 by T-016, which narrowed the username grammar to match the
  // database. The snapshot guard refuses to record a breaking change until this
  // constant has moved, so it is not free to change without also updating
  // `scripts/protocol-snapshot.json`.
  it('is 2, after the username grammar was narrowed', () => {
    expect(PROTOCOL_VERSION).toBe(2);
  });
});

describe('MIN_CLIENT_VERSION', () => {
  it('is a bare semantic version', () => {
    // The CLI prints it verbatim in "Server requires agentchat >= X.Y.Z", and
    // compares against it, so it must parse as semver with no range operator,
    // no `v` prefix, and no pre-release suffix.
    expect(MIN_CLIENT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
