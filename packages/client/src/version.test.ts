/**
 * The three outcomes of plan §12.4, from the client's side.
 *
 * Every server body below is built with an explicit `protocolVersion` rather
 * than the imported constant wherever the number is not the thing under test.
 * `PROTOCOL_VERSION` is 3 today and there is an open question about resetting it
 * before the first release; a suite that pinned the current value would have to
 * be edited when that decision is taken, which is exactly the coupling this
 * module's parameterised `protocolVersion` exists to avoid.
 */

import type { GetVersionResponse } from '@stackgrid/protocol';
import { PROTOCOL_VERSION, upgradeRequiredMessage } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import {
  type Compatibility,
  checkCompatibility,
  createServerOlderWarner,
  serverOlderWarning,
} from './version.js';

/**
 * A `GET /version` body.
 *
 * @param overrides - Fields to change.
 * @returns The body.
 */
function serverSays(overrides: Partial<GetVersionResponse> = {}): GetVersionResponse {
  return {
    version: '1.0.0',
    protocolVersion: 7,
    minClientVersion: '1.0.0',
    ...overrides,
  };
}

describe('checkCompatibility — too old', () => {
  it('refuses a client below the floor and hands back the exact instruction', () => {
    const verdict = checkCompatibility(
      { clientVersion: '0.9.0', protocolVersion: 7 },
      serverSays({ minClientVersion: '1.2.0' }),
    );

    expect(verdict.kind).toBe('client-too-old');
    if (verdict.kind !== 'client-too-old') {
      return;
    }
    expect(verdict.minClientVersion).toBe('1.2.0');
    expect(verdict.clientVersion).toBe('0.9.0');
    // Byte-identical to what the server puts in its own 426, because both call
    // the same function in `@stackgrid/protocol`.
    expect(verdict.message).toBe(
      'Server requires agentchat >= 1.2.0. Run: npm i -g @anmol098/agentchat@latest',
    );
    expect(verdict.message).toBe(upgradeRequiredMessage('1.2.0'));
  });

  it('compares versions numerically, not as strings', () => {
    // 0.9.0 sorts after 0.10.0 as a string. A client at 0.9.0 really is below a
    // 0.10.0 floor, and this is the case a naive comparison gets backwards.
    const verdict = checkCompatibility(
      { clientVersion: '0.9.0' },
      serverSays({ version: '0.10.0', minClientVersion: '0.10.0' }),
    );
    expect(verdict.kind).toBe('client-too-old');
  });

  it('wins over the older-server warning when both could apply', () => {
    // A client below the floor is also, here, newer in protocol than the
    // server. Only the refusal is actionable, so only the refusal is reported.
    const verdict = checkCompatibility(
      { clientVersion: '1.0.0', protocolVersion: 9 },
      serverSays({ version: '2.0.0', protocolVersion: 4, minClientVersion: '1.5.0' }),
    );
    expect(verdict.kind).toBe('client-too-old');
  });

  it('throws on a client version it cannot compare', () => {
    expect(() => checkCompatibility({ clientVersion: 'nightly' }, serverSays())).toThrow(TypeError);
  });
});

describe('checkCompatibility — too new', () => {
  it('warns and continues when the server is an older release', () => {
    const verdict = checkCompatibility(
      { clientVersion: '2.0.0', protocolVersion: 7 },
      serverSays({ version: '1.4.0', minClientVersion: '1.0.0' }),
    );

    expect(verdict.kind).toBe('server-older');
    if (verdict.kind !== 'server-older') {
      return;
    }
    expect(verdict.serverVersion).toBe('1.4.0');
    expect(verdict.clientVersion).toBe('2.0.0');
    expect(verdict.warning).toContain('agentchat 1.4.0');
    expect(verdict.warning).toContain('this client is 2.0.0');
    // The additive-only rule, stated where the user can act on it.
    expect(verdict.warning).toContain('best-effort');
    // One line. `agentchat listen` keeps stdout for payloads, and a warning
    // that wrapped into several lines would be indistinguishable from output.
    expect(verdict.warning).not.toContain('\n');
  });

  it('warns when only the protocol is behind', () => {
    const verdict = checkCompatibility(
      { clientVersion: '1.0.0', protocolVersion: 8 },
      serverSays({ version: '1.0.0', protocolVersion: 7 }),
    );
    expect(verdict.kind).toBe('server-older');
  });

  it('names both protocol numbers only when they differ', () => {
    const differing = serverOlderWarning(
      { clientVersion: '2.0.0', protocolVersion: 8 },
      serverSays({ version: '1.0.0', protocolVersion: 7 }),
    );
    expect(differing).toContain('speaks protocol 7');
    expect(differing).toContain('this client speaks 8');

    const same = serverOlderWarning(
      { clientVersion: '2.0.0', protocolVersion: 7 },
      serverSays({ version: '1.0.0', protocolVersion: 7 }),
    );
    // Restating two identical numbers buries the two that are not.
    expect(same).not.toContain('protocol');
  });
});

describe('checkCompatibility — matched', () => {
  it('says nothing when the versions agree', () => {
    const verdict = checkCompatibility(
      { clientVersion: '1.0.0', protocolVersion: 7 },
      serverSays({ version: '1.0.0', protocolVersion: 7, minClientVersion: '1.0.0' }),
    );
    expect(verdict).toEqual({ kind: 'compatible' });
  });

  it('treats a client exactly at the floor as compatible', () => {
    const verdict = checkCompatibility(
      { clientVersion: '1.0.0', protocolVersion: 7 },
      serverSays({ version: '1.0.0', minClientVersion: '1.0.0' }),
    );
    expect(verdict.kind).toBe('compatible');
  });

  it('says nothing when the server is newer but still serves this client', () => {
    // The server's `minClientVersion` is the authority on whether the two can
    // talk, and a client that clears it does not get to overrule it.
    const verdict = checkCompatibility(
      { clientVersion: '1.0.0', protocolVersion: 7 },
      serverSays({ version: '3.0.0', protocolVersion: 9, minClientVersion: '1.0.0' }),
    );
    expect(verdict.kind).toBe('compatible');
  });

  it('defaults the local protocol version to this build’s', () => {
    const verdict = checkCompatibility(
      { clientVersion: '1.0.0' },
      serverSays({ protocolVersion: PROTOCOL_VERSION }),
    );
    expect(verdict.kind).toBe('compatible');
  });
});

describe('createServerOlderWarner', () => {
  it('writes the warning once however often it is told', () => {
    const lines: string[] = [];
    const warn = createServerOlderWarner((line) => lines.push(line));

    const verdict = checkCompatibility(
      { clientVersion: '2.0.0', protocolVersion: 7 },
      serverSays({ version: '1.0.0' }),
    );

    // A listener reconnects with backoff, so the handshake runs repeatedly.
    // Plan §12.4 says "a one-line warning", singular.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      warn(verdict);
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('agentchat 1.0.0');
  });

  it('speaks again when the server changed under it', () => {
    const lines: string[] = [];
    const warn = createServerOlderWarner((line) => lines.push(line));
    const local = { clientVersion: '2.0.0', protocolVersion: 7 };

    warn(checkCompatibility(local, serverSays({ version: '1.0.0' })));
    // The operator upgraded mid-run. That is new information.
    warn(checkCompatibility(local, serverSays({ version: '1.5.0' })));

    expect(lines).toHaveLength(2);
  });

  it('writes nothing for a refusal or a match', () => {
    const lines: string[] = [];
    const warn = createServerOlderWarner((line) => lines.push(line));

    const verdicts: Compatibility[] = [
      checkCompatibility({ clientVersion: '0.1.0' }, serverSays({ minClientVersion: '1.0.0' })),
      checkCompatibility({ clientVersion: '1.0.0', protocolVersion: 7 }, serverSays()),
    ];
    for (const verdict of verdicts) {
      warn(verdict);
    }

    // A refusal is not a warning: whoever decides to stop owns printing it.
    expect(lines).toEqual([]);
  });
});
