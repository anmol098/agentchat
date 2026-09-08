import { describe, expect, it } from 'vitest';

import { UserId } from '../ids.js';
import {
  GetCurrentUserResponseSchema,
  LogoutRequestSchema,
  LogoutResponseSchema,
  PollDeviceAuthorizationRequestSchema,
  PollDeviceAuthorizationResponseSchema,
  RefreshTokensRequestSchema,
  RefreshTokensResponseSchema,
  StartDeviceAuthorizationRequestSchema,
  StartDeviceAuthorizationResponseSchema,
} from './auth.js';

const user = {
  id: UserId.generate(),
  username: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  createdAt: '2026-09-08T12:00:00.000Z',
};

describe('StartDeviceAuthorizationRequestSchema', () => {
  it('accepts an empty body', () => {
    expect(StartDeviceAuthorizationRequestSchema.parse({})).toStrictEqual({});
  });

  it('ignores a client that sends fields the server did not ask for', () => {
    expect(StartDeviceAuthorizationRequestSchema.parse({ clientId: 'mine' })).toStrictEqual({});
  });
});

describe('StartDeviceAuthorizationResponseSchema', () => {
  const response = {
    deviceCode: 'dev_9f3a1c2b4d5e6f708192a3b4c5d6e7f8',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    interval: 5,
    expiresIn: 900,
  };

  it('round-trips what the CLI needs to start polling', () => {
    expect(StartDeviceAuthorizationResponseSchema.parse(response)).toStrictEqual(response);
  });

  it('rejects a verification target that is not a URL', () => {
    expect(
      StartDeviceAuthorizationResponseSchema.safeParse({
        ...response,
        verificationUri: 'github.com/login/device',
      }).success,
    ).toBe(false);
  });

  it('rejects a poll interval of zero, which would mean a hot loop', () => {
    expect(
      StartDeviceAuthorizationResponseSchema.safeParse({ ...response, interval: 0 }).success,
    ).toBe(false);
  });

  it('rejects seconds sent as a string', () => {
    expect(
      StartDeviceAuthorizationResponseSchema.safeParse({ ...response, expiresIn: '900' }).success,
    ).toBe(false);
  });

  it('requires every field, so a half-built response cannot ship', () => {
    for (const key of Object.keys(response)) {
      const partial: Record<string, unknown> = { ...response };
      delete partial[key];
      expect(StartDeviceAuthorizationResponseSchema.safeParse(partial).success).toBe(false);
    }
  });
});

describe('PollDeviceAuthorizationRequestSchema', () => {
  it('round-trips the device code', () => {
    const request = { deviceCode: 'dev_9f3a1c2b' };
    expect(PollDeviceAuthorizationRequestSchema.parse(request)).toStrictEqual(request);
  });

  it('rejects a missing or empty device code', () => {
    expect(PollDeviceAuthorizationRequestSchema.safeParse({}).success).toBe(false);
    expect(PollDeviceAuthorizationRequestSchema.safeParse({ deviceCode: '' }).success).toBe(false);
  });
});

describe('PollDeviceAuthorizationResponseSchema', () => {
  const response = {
    accessToken: 'header.payload.signature',
    refreshToken: 'a'.repeat(64),
    user,
  };

  it('round-trips an approved authorization', () => {
    expect(PollDeviceAuthorizationResponseSchema.parse(response)).toStrictEqual(response);
  });

  it('requires the user, so the CLI never has tokens it cannot attribute', () => {
    const { user: _omitted, ...partial } = response;
    expect(PollDeviceAuthorizationResponseSchema.safeParse(partial).success).toBe(false);
  });

  it('rejects a nested user that is not a user', () => {
    expect(
      PollDeviceAuthorizationResponseSchema.safeParse({ ...response, user: { id: 'alice' } })
        .success,
    ).toBe(false);
  });
});

describe('RefreshTokensRequestSchema and RefreshTokensResponseSchema', () => {
  it('round-trip a rotation', () => {
    const request = { refreshToken: 'a'.repeat(64) };
    const response = { accessToken: 'header.payload.signature', refreshToken: 'b'.repeat(64) };
    expect(RefreshTokensRequestSchema.parse(request)).toStrictEqual(request);
    expect(RefreshTokensResponseSchema.parse(response)).toStrictEqual(response);
  });

  it('makes the new refresh token mandatory', () => {
    // Plan section 7 rotates on every refresh. A response without the new token
    // would leave the client unable to refresh again.
    expect(
      RefreshTokensResponseSchema.safeParse({ accessToken: 'header.payload.signature' }).success,
    ).toBe(false);
  });
});

describe('LogoutRequestSchema and LogoutResponseSchema', () => {
  it('take the refresh token and answer with nothing', () => {
    const request = { refreshToken: 'a'.repeat(64) };
    expect(LogoutRequestSchema.parse(request)).toStrictEqual(request);
    expect(LogoutResponseSchema.parse({})).toStrictEqual({});
  });

  it('rejects a logout with no token to revoke', () => {
    expect(LogoutRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('GetCurrentUserResponseSchema', () => {
  it('is the bare user, not a wrapper', () => {
    expect(GetCurrentUserResponseSchema.parse(user)).toStrictEqual(user);
    expect(GetCurrentUserResponseSchema.safeParse({ user }).success).toBe(false);
  });
});
