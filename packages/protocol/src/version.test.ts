import { describe, expect, it } from 'vitest';

import {
  compareSemanticVersions,
  isClientTooOld,
  MIN_CLIENT_VERSION,
  PROTOCOL_VERSION,
  UPGRADE_COMMAND,
  upgradeRequiredMessage,
} from './version.js';

describe('PROTOCOL_VERSION', () => {
  it('is a positive integer', () => {
    // Plan §12.4 calls for an integer, not a semver string: it names the shape
    // of the conversation, and only a non-additive change moves it.
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });

  // Moved to 2 by T-016, which narrowed the username grammar to match the
  // database, and to 3 by T-025, which did the same for the project slug. The
  // snapshot guard refuses to record a breaking change until this constant has
  // moved, so it is not free to change without also updating
  // `scripts/protocol-snapshot.json`.
  it('is 3, after the slug grammar was narrowed', () => {
    expect(PROTOCOL_VERSION).toBe(3);
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

describe('compareSemanticVersions', () => {
  it('orders by number and not by string', () => {
    // The reason this function exists. A string comparison puts 0.10.0 below
    // 0.9.0, and that is precisely the comparison deciding whether a user is
    // locked out of their own server.
    expect('0.10.0' < '0.9.0').toBe(true);
    expect(compareSemanticVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareSemanticVersions('1.0.0', '1.0.10')).toBeLessThan(0);
    expect(compareSemanticVersions('2.0.0', '10.0.0')).toBeLessThan(0);
  });

  it('is zero for equal versions and antisymmetric otherwise', () => {
    expect(compareSemanticVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemanticVersions('1.2.4', '1.2.3')).toBeGreaterThan(0);
    expect(compareSemanticVersions('1.2.3', '1.2.4')).toBeLessThan(0);
  });

  it('ranks a pre-release below the release it precedes (semver §11)', () => {
    expect(compareSemanticVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0);
    expect(compareSemanticVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemanticVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0);
    // Numeric identifiers compare numerically, and rank below alphanumeric ones.
    expect(compareSemanticVersions('1.0.0-rc.2', '1.0.0-rc.10')).toBeLessThan(0);
    expect(compareSemanticVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0);
    // A longer identifier list wins when everything before it is equal.
    expect(compareSemanticVersions('1.0.0-rc.1', '1.0.0-rc.1.1')).toBeLessThan(0);
  });

  it('ignores build metadata (semver §10)', () => {
    expect(compareSemanticVersions('1.2.3+build.5', '1.2.3')).toBe(0);
    expect(compareSemanticVersions('1.2.3+a', '1.2.3+b')).toBe(0);
  });

  it('refuses anything that is not a semantic version', () => {
    // Answering "equal" for an unparseable version would silently admit a
    // client the floor was meant to exclude, so this throws rather than guesses.
    for (const bad of ['', '1.2', 'v1.2.3', '1.2.3.4', '01.2.3', '>=1.2.3', 'latest']) {
      expect(() => compareSemanticVersions(bad, '1.0.0')).toThrow(TypeError);
      expect(() => compareSemanticVersions('1.0.0', bad)).toThrow(TypeError);
    }
  });
});

describe('isClientTooOld', () => {
  it('serves a client exactly at the floor', () => {
    // "Minimum" is inclusive. A strict comparison would strand the users who
    // did the upgrade they were told to do.
    expect(isClientTooOld('0.1.0', '0.1.0')).toBe(false);
  });

  it('refuses a client below the floor and serves one above it', () => {
    expect(isClientTooOld('0.0.9', '0.1.0')).toBe(true);
    expect(isClientTooOld('0.9.0', '0.10.0')).toBe(true);
    expect(isClientTooOld('0.2.0', '0.1.0')).toBe(false);
    expect(isClientTooOld('1.0.0', '0.1.0')).toBe(false);
  });

  it('refuses a pre-release of the floor itself', () => {
    // 0.1.0-rc.1 precedes 0.1.0, so it is below the floor.
    expect(isClientTooOld('0.1.0-rc.1', '0.1.0')).toBe(true);
  });
});

describe('upgradeRequiredMessage', () => {
  it('names the floor and the exact command, verbatim from plan §12.4', () => {
    expect(upgradeRequiredMessage('1.4.0')).toBe(
      'Server requires agentchat >= 1.4.0. Run: npm i -g agentchat@latest',
    );
  });

  it('takes the floor as a parameter rather than reading this build’s', () => {
    // The number that matters is the one the *server being talked to* reported,
    // which is not necessarily the one this build was compiled with.
    expect(upgradeRequiredMessage('9.9.9')).toContain('>= 9.9.9');
    expect(upgradeRequiredMessage(MIN_CLIENT_VERSION)).toContain(`>= ${MIN_CLIENT_VERSION}`);
  });

  it('ends in the command constant, so the two cannot drift', () => {
    expect(upgradeRequiredMessage('1.0.0').endsWith(UPGRADE_COMMAND)).toBe(true);
  });
});
