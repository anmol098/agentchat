import { describe, expect, it } from 'vitest';

import {
  ERROR_CODES,
  ErrorCode,
  ErrorCodeSchema,
  ErrorEnvelopeSchema,
  errorEnvelope,
  isErrorCode,
  ProtocolError,
} from './errors.js';

describe('ErrorCode', () => {
  it('pins the published set of codes', () => {
    // This list is a public contract (see the module note). Adding a code is a
    // minor change and updating this test is part of it; removing or renaming
    // one is a breaking change and this test is where that conversation starts.
    expect([...ERROR_CODES]).toStrictEqual([
      'BAD_REQUEST',
      'AUTH_REQUIRED',
      'AUTH_PENDING',
      'DEVICE_CODE_EXPIRED',
      'FORBIDDEN',
      'NOT_FOUND',
      'CONFLICT',
      'PAYLOAD_TOO_LARGE',
      'UPGRADE_REQUIRED',
      'INVITE_INVALID',
      'AGENT_DELETED',
      'AGENT_NOT_IN_PROJECT',
      'SESSION_INVALID',
      'PROTOCOL_VIOLATION',
      'INTERNAL',
      'SERVER_UNREACHABLE',
      'NO_PROJECT',
      'NO_AGENT',
    ]);
  });

  it('uses each code as its own key, so the two can never drift', () => {
    for (const [key, value] of Object.entries(ErrorCode)) {
      expect(key).toBe(value);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ErrorCode)).toBe(true);
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
    // @ts-expect-error - the codes are readonly at compile time too.
    expect(() => (ErrorCode.INTERNAL = 'OOPS')).toThrow(TypeError);
  });

  it('has no duplicates', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('uses SCREAMING_SNAKE_CASE throughout', () => {
    for (const code of ERROR_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
    }
  });
});

describe('SERVER_UNREACHABLE', () => {
  it('is a code of its own rather than an alias of INTERNAL', () => {
    // The whole point of T-017: a `--json` consumer sees two different strings
    // for "the network is down, retry" and "the server broke, report it".
    expect(ErrorCode.SERVER_UNREACHABLE).not.toBe(ErrorCode.INTERNAL);
    expect(isErrorCode('SERVER_UNREACHABLE')).toBe(true);
  });

  it('is accepted by the strict outbound schema', () => {
    // It never travels on the wire, but it is in the frozen set on the same
    // terms as NO_PROJECT and NO_AGENT, so the set's own schema must know it.
    expect(ErrorCodeSchema.parse('SERVER_UNREACHABLE')).toBe('SERVER_UNREACHABLE');
  });
});

describe('isErrorCode', () => {
  it('accepts every known code', () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
  });

  it('rejects unknown codes and non-strings', () => {
    expect(isErrorCode('SOMETHING_ELSE')).toBe(false);
    expect(isErrorCode('bad_request')).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
    expect(isErrorCode(500)).toBe(false);
  });
});

describe('ErrorCodeSchema', () => {
  it('accepts known codes and rejects everything else', () => {
    expect(ErrorCodeSchema.parse(ErrorCode.NOT_FOUND)).toBe('NOT_FOUND');
    expect(ErrorCodeSchema.safeParse('NOT_A_CODE').success).toBe(false);
  });
});

describe('ErrorEnvelopeSchema', () => {
  it('parses the envelope', () => {
    expect(
      ErrorEnvelopeSchema.parse({
        error: { code: 'FORBIDDEN', message: 'Not a member of this project.' },
      }),
    ).toStrictEqual({
      error: { code: 'FORBIDDEN', message: 'Not a member of this project.' },
    });
  });

  it('accepts a code it has never heard of', () => {
    // Plan §12.4: protocol changes are additive within a major version, so a
    // client must survive an error code that shipped after it did.
    const parsed = ErrorEnvelopeSchema.parse({
      error: { code: 'SHIPPED_LATER', message: 'From a newer server.' },
    });
    expect(parsed.error.code).toBe('SHIPPED_LATER');
    expect(isErrorCode(parsed.error.code)).toBe(false);
  });

  it('drops unknown sibling fields rather than failing', () => {
    const parsed = ErrorEnvelopeSchema.parse({
      error: { code: 'INTERNAL', message: 'boom', details: { trace: 'x' } },
      requestId: 'abc',
    });
    expect(parsed).toStrictEqual({ error: { code: 'INTERNAL', message: 'boom' } });
  });

  it.each([
    ['a missing envelope', {}],
    ['a missing code', { error: { message: 'x' } }],
    ['an empty code', { error: { code: '', message: 'x' } }],
    ['a non-string code', { error: { code: 500, message: 'x' } }],
    ['a missing message', { error: { code: 'INTERNAL' } }],
    ['a null error', { error: null }],
    ['a bare string', 'INTERNAL'],
  ])('rejects %s', (_label, value) => {
    expect(ErrorEnvelopeSchema.safeParse(value).success).toBe(false);
  });
});

describe('errorEnvelope', () => {
  it('builds an envelope that its own schema accepts', () => {
    const envelope = errorEnvelope(ErrorCode.CONFLICT, 'Agent name taken.');
    expect(envelope).toStrictEqual({
      error: { code: 'CONFLICT', message: 'Agent name taken.' },
    });
    expect(ErrorEnvelopeSchema.safeParse(envelope).success).toBe(true);
  });
});

describe('ProtocolError', () => {
  it('is an Error carrying a stable code', () => {
    const error = new ProtocolError(ErrorCode.NOT_FOUND, 'No such project.');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ProtocolError);
    expect(error.name).toBe('ProtocolError');
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('No such project.');
  });

  it('keeps the underlying cause', () => {
    const cause = new Error('connection reset');
    const error = new ProtocolError(ErrorCode.INTERNAL, 'Upstream failed.', {
      cause,
    });
    expect(error.cause).toBe(cause);
  });

  it('renders itself as the wire envelope', () => {
    const error = new ProtocolError(ErrorCode.UPGRADE_REQUIRED, 'Too old.');
    expect(error.toEnvelope()).toStrictEqual({
      error: { code: 'UPGRADE_REQUIRED', message: 'Too old.' },
    });
    expect(ErrorEnvelopeSchema.safeParse(error.toEnvelope()).success).toBe(true);
  });
});
