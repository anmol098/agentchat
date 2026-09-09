import { ApiError, ResponseFormatError, TransportError } from '@agentchat/client';
import { ERROR_CODES, ErrorCode, ProtocolError } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import { CliError, causeChain, describeFailure, UsageError } from './errors.js';
import { ExitCode } from './exit.js';

describe('describeFailure', () => {
  it('offers a next step for every code in the frozen set', () => {
    // The reason this module exists. A code and a message tell a user what
    // happened; only the hint tells them what to do about it.
    for (const code of ERROR_CODES) {
      const failure = describeFailure(new ProtocolError(code, 'something happened'));
      expect(failure.hint, `${code} has no hint`).toBeTruthy();
    }
  });

  it('prefers the hint the thrower attached', () => {
    const failure = describeFailure(
      new CliError(ErrorCode.NO_PROJECT, 'no project here', { hint: 'Run `agentchat setup`.' }),
    );

    expect(failure.hint).toBe('Run `agentchat setup`.');
    expect(failure.exit).toBe(ExitCode.NO_CONTEXT);
  });

  it('reports the wire code and reasons about the known one', () => {
    // A newer server sends a code this build was not compiled with. The string
    // must survive for a consumer that does know it, while the exit code has to
    // come from something this process can actually switch on.
    const failure = describeFailure(new ApiError(503, 'QUOTA_EXCEEDED', 'Slow down.'));

    expect(failure.code).toBe('QUOTA_EXCEEDED');
    expect(failure.knownCode).toBe(ErrorCode.INTERNAL);
    expect(failure.exit).toBe(ExitCode.FAILURE);
  });

  it('keeps the two equal for a code this build knows', () => {
    const failure = describeFailure(new ApiError(401, 'AUTH_REQUIRED', 'expired'));

    expect(failure.code).toBe('AUTH_REQUIRED');
    expect(failure.knownCode).toBe(ErrorCode.AUTH_REQUIRED);
    expect(failure.exit).toBe(ExitCode.AUTH_REQUIRED);
  });

  it('gives a refusal, a timeout, and a server fault three distinguishable codes', () => {
    // `Failure.code` is the string that reaches `--json` (see `main.ts`), so
    // this is the acceptance test for T-017 at the boundary that matters: a
    // harness reading stdout, with no access to a JavaScript class.
    const refused = describeFailure(new TransportError('connect ECONNREFUSED 127.0.0.1:8080'));
    const timedOut = describeFailure(new TransportError('The request timed out after 30000ms.'));
    const faulted = describeFailure(
      new ApiError(500, 'INTERNAL', 'The server failed to handle this request.'),
    );

    // A refusal and a timeout are one code on purpose — same remedy, and not
    // reliably distinguishable — while the server fault is the one a caller
    // must act on differently.
    expect(refused.code).toBe(ErrorCode.SERVER_UNREACHABLE);
    expect(timedOut.code).toBe(ErrorCode.SERVER_UNREACHABLE);
    expect(faulted.code).toBe(ErrorCode.INTERNAL);
    expect(faulted.code).not.toBe(refused.code);

    // The hints differ too, and for the same reason: check your own network,
    // versus report it against the request id.
    expect(refused.hint).toContain('network connection');
    expect(faulted.hint).not.toBe(refused.hint);
  });

  it('still recognises an unparseable response by class, because its code is honest', () => {
    // `ResponseFormatError` keeps INTERNAL: the server answered, in violation
    // of its own contract, which is a server fault. Only the hint is sharper,
    // and a hint is not something a consumer branches on.
    const format = describeFailure(new ResponseFormatError('the body did not parse'));

    expect(format.code).toBe(ErrorCode.INTERNAL);
    expect(format.hint).toContain('Update');
  });

  it('never lets a thrown non-error escape as one', () => {
    for (const thrown of [undefined, null, 'a string', 42, { code: 'nope' }]) {
      const failure = describeFailure(thrown);

      expect(failure.code).toBe(ErrorCode.INTERNAL);
      expect(failure.exit).toBe(ExitCode.FAILURE);
      // The raw value is never the message: it may be anything at all, and a
      // user can do nothing with it.
      expect(failure.message).toBe('An unexpected internal error occurred.');
      expect(failure.cause).toBe(thrown);
    }
  });

  it('does not put a bug`s message in front of the user', () => {
    const failure = describeFailure(new TypeError('cannot read properties of undefined'));

    expect(failure.message).not.toContain('undefined');
    expect(failure.hint).toContain('--verbose');
  });
});

describe('UsageError', () => {
  it('carries BAD_REQUEST, which is exit 2', () => {
    const failure = describeFailure(new UsageError('unknown flag `--nope`'));

    expect(failure.code).toBe(ErrorCode.BAD_REQUEST);
    expect(failure.exit).toBe(ExitCode.USAGE);
  });
});

describe('causeChain', () => {
  it('reports messages, outermost first, and never a stack', () => {
    const chain = causeChain(
      new TypeError('outer', { cause: new Error('middle', { cause: 'inner' }) }),
    );

    expect(chain).toEqual(['TypeError: outer', 'Error: middle', 'inner']);
    expect(chain.join('\n')).not.toContain('    at ');
  });

  it('terminates on a cycle', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    (first as { cause?: unknown }).cause = second;

    expect(causeChain(second).length).toBeLessThanOrEqual(8);
  });
});
