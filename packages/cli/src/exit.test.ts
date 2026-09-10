import { ERROR_CODES, ErrorCode } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import { ExitCode, exitCodeForErrorCode } from './exit.js';

describe('the exit-code contract', () => {
  it('has exactly the five codes plan §6.2 defines', () => {
    expect(ExitCode).toEqual({
      OK: 0,
      FAILURE: 1,
      USAGE: 2,
      AUTH_REQUIRED: 3,
      NO_CONTEXT: 4,
    });
  });

  it('maps every code in the frozen set', () => {
    // The switch has no `default`, so this cannot regress silently — but a code
    // added to the protocol without a mapping here would be a compile error, and
    // this asserts the runtime consequence too.
    for (const code of ERROR_CODES) {
      const exit = exitCodeForErrorCode(code);
      expect(Object.values(ExitCode), `${code} mapped to ${String(exit)}`).toContain(exit);
    }
  });

  it('sends every route back to `agentchat login` to 3', () => {
    expect(exitCodeForErrorCode(ErrorCode.AUTH_REQUIRED)).toBe(ExitCode.AUTH_REQUIRED);
    expect(exitCodeForErrorCode(ErrorCode.AUTH_PENDING)).toBe(ExitCode.AUTH_REQUIRED);
    expect(exitCodeForErrorCode(ErrorCode.DEVICE_CODE_EXPIRED)).toBe(ExitCode.AUTH_REQUIRED);
  });

  it('sends unresolvable context to 4, and nothing else', () => {
    expect(exitCodeForErrorCode(ErrorCode.NO_PROJECT)).toBe(ExitCode.NO_CONTEXT);
    expect(exitCodeForErrorCode(ErrorCode.NO_AGENT)).toBe(ExitCode.NO_CONTEXT);

    // Tempting, and deliberately not 4: plan §6.2 defines 4 as "no
    // project/agent context", and this agent has both — it is simply not a
    // member. Widening a published exit code is a contract change.
    expect(exitCodeForErrorCode(ErrorCode.AGENT_NOT_IN_PROJECT)).toBe(ExitCode.FAILURE);
  });

  it('treats a malformed request as a usage error, whoever noticed it', () => {
    expect(exitCodeForErrorCode(ErrorCode.BAD_REQUEST)).toBe(ExitCode.USAGE);
  });

  it('leaves an unreachable server on 1, alongside the fault it is distinct from', () => {
    // T-017 separated these two *codes* because they call for opposite actions.
    // It deliberately did not separate their exit codes: exit 1 already means
    // "may retry", and a new exit code has to earn its place with a different
    // automatable remedy, which this does not have. The distinction lives in
    // `error.code`, where a harness can read it.
    expect(exitCodeForErrorCode(ErrorCode.SERVER_UNREACHABLE)).toBe(ExitCode.FAILURE);
    expect(exitCodeForErrorCode(ErrorCode.INTERNAL)).toBe(ExitCode.FAILURE);
  });

  it('leaves a rate limit on 1, for want of a channel wide enough to help', () => {
    // The closest call in the table. Its remedy *is* automatable and *is*
    // different — sleep for `Retry-After`, resend unchanged — but an exit code
    // cannot carry the interval, so a harness has to read the JSON for it
    // anyway, and `code` is right there.
    expect(exitCodeForErrorCode(ErrorCode.RATE_LIMITED)).toBe(ExitCode.FAILURE);
  });
});
