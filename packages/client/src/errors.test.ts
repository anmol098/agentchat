import { ErrorCode, ProtocolError } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import {
  ApiError,
  apiErrorFromResponse,
  codeForStatus,
  ResponseFormatError,
  TransportError,
} from './errors.js';

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
  it('is a ProtocolError carrying INTERNAL, and keeps the cause', () => {
    const cause = new TypeError('fetch failed');
    const error = new TransportError('Could not reach the server.', { cause });

    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.code).toBe(ErrorCode.INTERNAL);
    expect(error.name).toBe('TransportError');
    expect(error.cause).toBe(cause);
  });

  it('is distinguishable from a server-side INTERNAL by its class', () => {
    const server = apiErrorFromResponse(500, { error: { code: 'INTERNAL', message: 'boom' } });
    expect(server).not.toBeInstanceOf(TransportError);
    expect(new TransportError('x')).not.toBeInstanceOf(ApiError);
  });
});

describe('ResponseFormatError', () => {
  it('is a ProtocolError carrying INTERNAL', () => {
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
