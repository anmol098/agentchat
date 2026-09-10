/**
 * The GitHub device flow, tested against a stubbed provider.
 *
 * **Nothing here talks to github.com.** Every test injects its own `fetch`, so
 * the suite is deterministic, runs offline, and — the point — cannot be made to
 * pass by a real OAuth app that happens to be configured on somebody's machine.
 *
 * What is under test is the mapping: provider vocabulary in, AgentChat
 * vocabulary out, with the four device-flow states each preserved as something
 * distinct and the client secret preserved as something invisible.
 */

import { ErrorCode, ProtocolError } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import {
  createGitHubIdentityProvider,
  type FetchLike,
  GITHUB_ACCESS_TOKEN_URL,
  GITHUB_DEVICE_CODE_URL,
  GITHUB_USER_URL,
} from './github.js';
import type { DeviceAuthorizationOutcome } from './identity.js';

/** A recorded outbound request. */
interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  /** The form or JSON body as sent, verbatim. */
  readonly body: string;
}

/** What the stub should answer with for one call. */
type StubReply = { status?: number; json: unknown } | { status?: number; text: string } | Error;

/** A stubbed `fetch` that answers by URL and records what it was asked. */
function stubFetch(replies: Record<string, StubReply>): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const fetch: FetchLike = (url, init) => {
    const headers = init.headers as Record<string, string> | undefined;
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: headers ?? {},
      body: typeof init.body === 'string' ? init.body : '',
    });

    const reply = replies[url];
    if (reply === undefined) {
      return Promise.reject(new Error(`No stub configured for ${url}`));
    }
    if (reply instanceof Error) {
      return Promise.reject(reply);
    }

    const status = reply.status ?? 200;
    const payload = 'json' in reply ? JSON.stringify(reply.json) : reply.text;

    return Promise.resolve(
      new Response(payload, { status, headers: { 'content-type': 'application/json' } }),
    );
  };

  return { fetch, calls };
}

/** A device authorization as GitHub returns one. */
const deviceCodeReply = {
  json: {
    device_code: 'provider-device-code',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  },
};

/** A profile as GitHub returns one. */
const profileReply = {
  json: { id: 4207, login: 'Alice-Smith', name: 'Alice Smith', email: 'alice@example.com' },
};

/** The form fields of a recorded call, parsed. */
function formOf(call: RecordedCall): URLSearchParams {
  return new URLSearchParams(call.body);
}

/** Finds the one call made to a URL. */
function callTo(calls: RecordedCall[], url: string): RecordedCall {
  const found = calls.find((call) => call.url === url);
  if (found === undefined) {
    throw new Error(`Expected a call to ${url}, got ${calls.map((c) => c.url).join(', ')}`);
  }
  return found;
}

/** Polls with a token endpoint that answers `body`. */
async function pollWith(body: unknown): Promise<DeviceAuthorizationOutcome> {
  const { fetch } = stubFetch({
    [GITHUB_ACCESS_TOKEN_URL]: { json: body },
    [GITHUB_USER_URL]: profileReply,
  });

  return await createGitHubIdentityProvider({
    clientId: 'client-id',
    fetch,
  }).redeemDeviceAuthorization('provider-device-code');
}

describe('createGitHubIdentityProvider', () => {
  it('refuses to be built without a client id', () => {
    expect(() => createGitHubIdentityProvider({ clientId: '   ' })).toThrow(ProtocolError);
  });

  describe('startDeviceAuthorization', () => {
    it('asks the provider for a device code and maps the response', async () => {
      const { fetch, calls } = stubFetch({ [GITHUB_DEVICE_CODE_URL]: deviceCodeReply });

      const grant = await createGitHubIdentityProvider({
        clientId: 'client-id',
        fetch,
      }).startDeviceAuthorization();

      expect(grant).toEqual({
        deviceCode: 'provider-device-code',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        interval: 5,
        expiresIn: 900,
      });

      const call = callTo(calls, GITHUB_DEVICE_CODE_URL);
      expect(call.method).toBe('POST');
      expect(call.headers['accept']).toBe('application/json');
      expect(formOf(call).get('client_id')).toBe('client-id');
      expect(formOf(call).get('scope')).toBe('read:user');
    });

    it('never sends the client secret to the device code endpoint', async () => {
      const { fetch, calls } = stubFetch({ [GITHUB_DEVICE_CODE_URL]: deviceCodeReply });

      await createGitHubIdentityProvider({
        clientId: 'client-id',
        clientSecret: 'super-secret-value',
        fetch,
      }).startDeviceAuthorization();

      const call = callTo(calls, GITHUB_DEVICE_CODE_URL);
      expect(call.body).not.toContain('super-secret-value');
      expect(call.url).not.toContain('super-secret-value');
    });

    it('falls back to the RFC default when the provider states no interval', async () => {
      const { device_code, user_code, verification_uri, expires_in } = deviceCodeReply.json;
      const { fetch } = stubFetch({
        [GITHUB_DEVICE_CODE_URL]: {
          json: { device_code, user_code, verification_uri, expires_in },
        },
      });

      const grant = await createGitHubIdentityProvider({
        clientId: 'client-id',
        fetch,
      }).startDeviceAuthorization();

      expect(grant.interval).toBe(5);
    });

    it('reports a non-2xx as the server the fault of the server, not the caller', async () => {
      const { fetch } = stubFetch({
        [GITHUB_DEVICE_CODE_URL]: { status: 503, json: { message: 'unavailable' } },
      });

      const provider = createGitHubIdentityProvider({ clientId: 'client-id', fetch });

      await expect(provider.startDeviceAuthorization()).rejects.toMatchObject({
        code: ErrorCode.INTERNAL,
      });
    });

    it('reports a body that is not JSON as a provider fault', async () => {
      const { fetch } = stubFetch({ [GITHUB_DEVICE_CODE_URL]: { text: '<html>nope</html>' } });

      const provider = createGitHubIdentityProvider({ clientId: 'client-id', fetch });

      await expect(provider.startDeviceAuthorization()).rejects.toMatchObject({
        code: ErrorCode.INTERNAL,
      });
    });

    it('does not echo the device code when the response cannot be parsed', async () => {
      const { fetch } = stubFetch({
        [GITHUB_DEVICE_CODE_URL]: { json: { device_code: 'leaky-code', user_code: 'ABCD' } },
      });

      const provider = createGitHubIdentityProvider({ clientId: 'client-id', fetch });

      const error = await provider.startDeviceAuthorization().catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(ProtocolError);
      expect(String((error as Error).message)).not.toContain('leaky-code');
    });
  });

  describe('redeemDeviceAuthorization', () => {
    it('keeps the user waiting while the authorization is pending', async () => {
      await expect(pollWith({ error: 'authorization_pending' })).resolves.toEqual({
        status: 'pending',
      });
    });

    it('reports slow_down with the interval the provider asked for', async () => {
      await expect(pollWith({ error: 'slow_down', interval: 42 })).resolves.toEqual({
        status: 'slow_down',
        interval: 42,
      });
    });

    it('reports slow_down with a backed-off interval when the provider states none', async () => {
      await expect(pollWith({ error: 'slow_down' })).resolves.toEqual({
        status: 'slow_down',
        interval: 10,
      });
    });

    it('reports a denial distinctly from an expiry', async () => {
      await expect(pollWith({ error: 'access_denied' })).resolves.toEqual({ status: 'denied' });
      await expect(pollWith({ error: 'expired_token' })).resolves.toEqual({ status: 'expired' });
    });

    it('treats an unknown device code as terminal, like an expiry', async () => {
      await expect(pollWith({ error: 'incorrect_device_code' })).resolves.toEqual({
        status: 'expired',
      });
    });

    it('treats a misconfigured OAuth app as the server fault it is', async () => {
      await expect(pollWith({ error: 'device_flow_disabled' })).rejects.toMatchObject({
        code: ErrorCode.INTERNAL,
      });
      await expect(pollWith({ error: 'incorrect_client_credentials' })).rejects.toMatchObject({
        code: ErrorCode.INTERNAL,
      });
    });

    it('reports a body carrying neither a token nor an error as a provider fault', async () => {
      await expect(pollWith({ scope: 'read:user' })).rejects.toMatchObject({
        code: ErrorCode.INTERNAL,
      });
    });

    it('reads the profile on approval and lowercases the username', async () => {
      const { fetch, calls } = stubFetch({
        [GITHUB_ACCESS_TOKEN_URL]: { json: { access_token: 'gho_provider_token' } },
        [GITHUB_USER_URL]: profileReply,
      });

      const outcome = await createGitHubIdentityProvider({
        clientId: 'client-id',
        fetch,
      }).redeemDeviceAuthorization('provider-device-code');

      expect(outcome).toEqual({
        status: 'approved',
        identity: {
          subject: '4207',
          username: 'alice-smith',
          displayName: 'Alice Smith',
          email: 'alice@example.com',
        },
      });

      expect(callTo(calls, GITHUB_USER_URL).headers['authorization']).toBe(
        'Bearer gho_provider_token',
      );
    });

    it('reports a token response in an unexpected shape as a provider fault', async () => {
      // Not a parse failure zod can describe to anybody useful: the body is a
      // JSON array where an object was promised, so there is no field to name.
      await expect(pollWith(['unexpected'])).rejects.toMatchObject({
        code: ErrorCode.INTERNAL,
      });
    });

    it('reports a refused profile request as a provider fault', async () => {
      const { fetch } = stubFetch({
        [GITHUB_ACCESS_TOKEN_URL]: { json: { access_token: 'token' } },
        [GITHUB_USER_URL]: { status: 401, json: { message: 'Bad credentials' } },
      });

      const provider = createGitHubIdentityProvider({ clientId: 'client-id', fetch });

      // A token the provider just issued and will not honour is the provider's
      // problem or this server's, never the person logging in: they did
      // everything right and there is nothing for them to retry differently.
      await expect(provider.redeemDeviceAuthorization('code')).rejects.toMatchObject({
        code: ErrorCode.INTERNAL,
      });
    });

    it('reports a profile it cannot read as a provider fault', async () => {
      const { fetch } = stubFetch({
        [GITHUB_ACCESS_TOKEN_URL]: { json: { access_token: 'token' } },
        // No `login`, so there is no username to store and no fallback that
        // would not be an invention.
        [GITHUB_USER_URL]: { json: { id: 7 } },
      });

      const provider = createGitHubIdentityProvider({ clientId: 'client-id', fetch });

      await expect(provider.redeemDeviceAuthorization('code')).rejects.toMatchObject({
        code: ErrorCode.INTERNAL,
      });
    });

    it('never returns the provider access token', async () => {
      const { fetch } = stubFetch({
        [GITHUB_ACCESS_TOKEN_URL]: { json: { access_token: 'gho_provider_token' } },
        [GITHUB_USER_URL]: profileReply,
      });

      const outcome = await createGitHubIdentityProvider({
        clientId: 'client-id',
        fetch,
      }).redeemDeviceAuthorization('provider-device-code');

      expect(JSON.stringify(outcome)).not.toContain('gho_provider_token');
    });

    it('falls back to the login when the provider has no display name', async () => {
      const { fetch } = stubFetch({
        [GITHUB_ACCESS_TOKEN_URL]: { json: { access_token: 'token' } },
        [GITHUB_USER_URL]: { json: { id: 1, login: 'Bob', name: '   ', email: null } },
      });

      const outcome = await createGitHubIdentityProvider({
        clientId: 'client-id',
        fetch,
      }).redeemDeviceAuthorization('code');

      expect(outcome).toEqual({
        status: 'approved',
        identity: { subject: '1', username: 'bob', displayName: 'Bob', email: null },
      });
    });

    it('stores no email when the provider supplies something that is not one', async () => {
      const { fetch } = stubFetch({
        [GITHUB_ACCESS_TOKEN_URL]: { json: { access_token: 'token' } },
        [GITHUB_USER_URL]: {
          json: { id: 2, login: 'carol', name: 'Carol', email: 'not-an-email' },
        },
      });

      const outcome = await createGitHubIdentityProvider({
        clientId: 'client-id',
        fetch,
      }).redeemDeviceAuthorization('code');

      expect(outcome).toMatchObject({ identity: { email: null } });
    });

    it('sends the client secret to the token endpoint only, in the body', async () => {
      const { fetch, calls } = stubFetch({
        [GITHUB_ACCESS_TOKEN_URL]: { json: { error: 'authorization_pending' } },
      });

      await createGitHubIdentityProvider({
        clientId: 'client-id',
        clientSecret: 'super-secret-value',
        fetch,
      }).redeemDeviceAuthorization('provider-device-code');

      const call = callTo(calls, GITHUB_ACCESS_TOKEN_URL);
      expect(formOf(call).get('client_secret')).toBe('super-secret-value');
      expect(call.url).not.toContain('super-secret-value');
      expect(formOf(call).get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
    });

    it('scrubs the client secret out of a transport failure, cause and all', async () => {
      const leak = new Error('POST failed: client_secret=super-secret-value refused');
      const { fetch } = stubFetch({ [GITHUB_ACCESS_TOKEN_URL]: leak });

      const provider = createGitHubIdentityProvider({
        clientId: 'client-id',
        clientSecret: 'super-secret-value',
        fetch,
      });

      const error = await provider
        .redeemDeviceAuthorization('provider-device-code')
        .catch((cause: unknown) => cause);

      expect(error).toBeInstanceOf(ProtocolError);
      const thrown = error as ProtocolError;
      expect(thrown.code).toBe(ErrorCode.INTERNAL);
      expect(thrown.message).toContain('[redacted]');
      expect(thrown.message).not.toContain('super-secret-value');
      // The cause is dropped rather than attached, because the logger walks it.
      expect(thrown.cause).toBeUndefined();
    });
  });
});
