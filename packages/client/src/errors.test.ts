import { ErrorCode, ProtocolError } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import {
  ApiError,
  apiErrorFromResponse,
  codeForStatus,
  ResponseFormatError,
  TransportError,
} from './errors.js';
import { HttpTransport } from './http-transport.js';
import { MOCK_BASE_URL, MockServer } from './testing/mock-server.js';

describe('codeForStatus', () => {
  it('maps each status to the code the protocol documents for it', () => {
    expect(codeForStatus(400)).toBe(ErrorCode.BAD_REQUEST);
    expect(codeForStatus(401)).toBe(ErrorCode.AUTH_REQUIRED);
    expect(codeForStatus(403)).toBe(ErrorCode.FORBIDDEN);
    expect(codeForStatus(404)).toBe(ErrorCode.NOT_FOUND);
    expect(codeForStatus(409)).toBe(ErrorCode.CONFLICT);
    expect(codeForStatus(413)).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
    expect(codeForStatus(426)).toBe(ErrorCode.UPGRADE_REQUIRED);
    expect(codeForStatus(428)).toBe(ErrorCode.AUTH_PENDING);
  });

  it('falls back to INTERNAL for a status with no unambiguous code', () => {
    expect(codeForStatus(500)).toBe(ErrorCode.INTERNAL);
    expect(codeForStatus(502)).toBe(ErrorCode.INTERNAL);
    expect(codeForStatus(410)).toBe(ErrorCode.INTERNAL);
  });
});

describe('apiErrorFromResponse', () => {
  it('preserves the stable code the server sent', () => {
    const error = apiErrorFromResponse(409, {
      error: { code: 'CONFLICT', message: 'That slug is taken.' },
    });

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(ErrorCode.CONFLICT);
    expect(error.wireCode).toBe('CONFLICT');
    expect(error.status).toBe(409);
    expect(error.message).toBe('That slug is taken.');
  });

  it('is a ProtocolError, so a consumer needs only one taxonomy', () => {
    const error = apiErrorFromResponse(403, { error: { code: 'FORBIDDEN', message: 'No.' } });
    expect(error).toBeInstanceOf(ProtocolError);
  });

  it('keeps a code this build has never heard of, and still gives a usable one', () => {
    const error = apiErrorFromResponse(403, {
      error: { code: 'QUOTA_EXCEEDED', message: 'Too many projects.' },
    });

    expect(error.wireCode).toBe('QUOTA_EXCEEDED');
    expect(error.isKnownCode).toBe(false);
    expect(error.code).toBe(ErrorCode.FORBIDDEN);
  });

  it('reports a known code as known', () => {
    expect(
      apiErrorFromResponse(404, { error: { code: 'NOT_FOUND', message: 'x' } }).isKnownCode,
    ).toBe(true);
  });

  it('synthesises a code when a proxy answers with something that is not an envelope', () => {
    const error = apiErrorFromResponse(502, undefined);

    expect(error.code).toBe(ErrorCode.INTERNAL);
    expect(error.status).toBe(502);
    expect(error.message).toContain('no readable error body');
  });

  it('synthesises a code when the body is JSON of some other shape', () => {
    const error = apiErrorFromResponse(403, { message: 'nope' });
    expect(error.code).toBe(ErrorCode.FORBIDDEN);
    expect(error.wireCode).toBe(ErrorCode.FORBIDDEN);
  });
});

describe('TransportError', () => {
  it('is a ProtocolError carrying SERVER_UNREACHABLE, and keeps the cause', () => {
    const cause = new TypeError('fetch failed');
    const error = new TransportError('Could not reach the server.', { cause });

    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.code).toBe(ErrorCode.SERVER_UNREACHABLE);
    expect(error.name).toBe('TransportError');
    expect(error.cause).toBe(cause);
  });

  it('is distinguishable from a server-side INTERNAL by its class', () => {
    const server = apiErrorFromResponse(500, { error: { code: 'INTERNAL', message: 'boom' } });
    expect(server).not.toBeInstanceOf(TransportError);
    expect(new TransportError('x')).not.toBeInstanceOf(ApiError);
  });

  it('puts the same code on a refusal and on a timeout', () => {
    // One code for both, deliberately: see the code's documentation in
    // `@agentchat/protocol`. What separates them is the message and the cause.
    const refused = new TransportError('connect ECONNREFUSED 127.0.0.1:8080');
    const timedOut = new TransportError('The request timed out after 30000ms.');

    expect(refused.code).toBe(timedOut.code);
    expect(refused.message).not.toBe(timedOut.message);
  });
});

describe('an unreachable server against a server that faulted', () => {
  /** Sentinel asking {@link failingTransport} to hang until its timeout fires. */
  const TIMEOUT = Symbol('timeout');

  /**
   * A transport whose `fetch` always fails the way the runtime fails.
   *
   * @param cause - What `fetch` rejects with.
   * @returns A transport pointed at the mock base URL.
   */
  function failingTransport(cause: unknown): HttpTransport {
    return new HttpTransport({
      baseUrl: MOCK_BASE_URL,
      timeoutMs: 10,
      fetch: (_input, init) =>
        cause === TIMEOUT
          ? new Promise((_resolve, reject) => {
              init.signal?.addEventListener('abort', () => {
                reject(new DOMException('The operation was aborted.', 'TimeoutError'));
              });
            })
          : Promise.reject(cause),
    });
  }

  /**
   * The error code the client reports for one failure mode.
   *
   * @param act - The call under test.
   * @returns The `code` of whatever it threw.
   */
  async function codeThrownBy(act: () => Promise<unknown>): Promise<string> {
    try {
      await act();
    } catch (error) {
      return (error as ProtocolError).code;
    }
    throw new Error('the call was expected to fail and did not');
  }

  it('reports three different codes for a refusal, a timeout, and a 500', async () => {
    // The reason T-017 exists. All three used to arrive as INTERNAL, so a
    // `--json` consumer could not tell "retry, the network is down" from
    // "report it, the server broke" — opposite actions behind one string.
    const refused = await codeThrownBy(() =>
      failingTransport(
        Object.assign(new TypeError('fetch failed'), {
          cause: new Error('connect ECONNREFUSED 127.0.0.1:8080'),
        }),
      ).request({ method: 'GET', path: '/me' }),
    );

    const timedOut = await codeThrownBy(() =>
      failingTransport(TIMEOUT).request({ method: 'GET', path: '/me' }),
    );

    const server = new MockServer();
    server.reply('GET /me', {
      status: 500,
      body: { error: { code: 'INTERNAL', message: 'The server failed to handle this request.' } },
    });
    const answered = await new HttpTransport({
      baseUrl: MOCK_BASE_URL,
      fetch: server.fetch(),
    }).request({ method: 'GET', path: '/me' });
    const faulted = apiErrorFromResponse(answered.status, answered.body);

    expect(refused).toBe(ErrorCode.SERVER_UNREACHABLE);
    expect(timedOut).toBe(ErrorCode.SERVER_UNREACHABLE);
    expect(faulted.code).toBe(ErrorCode.INTERNAL);
    expect(faulted.code).not.toBe(refused);
  });

  it('carries the distinction in the wire envelope, not only in the class', () => {
    // `toEnvelope` is what a `--json` consumer ends up reading, and it holds
    // nothing but the code and the message. If the code did not differ, the
    // distinction would not survive leaving the process.
    const unreachable = new TransportError('Could not reach https://chat.example.com.');
    const faulted = apiErrorFromResponse(500, {
      error: { code: 'INTERNAL', message: 'boom' },
    });

    expect(unreachable.toEnvelope().error.code).toBe('SERVER_UNREACHABLE');
    expect(faulted.toEnvelope().error.code).toBe('INTERNAL');
  });
});

describe('ResponseFormatError', () => {
  it('keeps INTERNAL: the server answered, it just answered wrongly', () => {
    const error = new ResponseFormatError('bad shape');
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.code).toBe(ErrorCode.INTERNAL);
    expect(error.name).toBe('ResponseFormatError');
  });
});

describe('ApiError.toEnvelope', () => {
  it('round-trips back to the wire shape, inherited from ProtocolError', () => {
    const error = new ApiError(404, 'NOT_FOUND', 'Nothing here.');
    expect(error.toEnvelope()).toStrictEqual({
      error: { code: 'NOT_FOUND', message: 'Nothing here.' },
    });
  });
});
