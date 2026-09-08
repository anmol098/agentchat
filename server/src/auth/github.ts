/**
 * The reference identity provider: GitHub's OAuth device flow (D4, plan §7).
 *
 * ## This is the only file that knows the provider is GitHub
 *
 * Plan §7 is explicit that "nothing in the protocol depends on GitHub", and D4
 * makes GitHub the *reference* provider rather than part of the contract. That
 * promise is only worth anything if something enforces it, so this module is
 * built as an implementation of `IdentityProvider` — an interface declared in
 * `./identity.ts`, whose vocabulary is RFC 8628's (device code, user code,
 * authorization pending, slow down, expired, denied) and not GitHub's.
 *
 * Everything above it — `routes/auth.ts` today, whatever else needs a login
 * later — imports that module and not this one. A self-hoster pointing at a
 * different provider writes a second implementation and changes one line of
 * wiring; no route, no schema and no error code moves. The seam being a file of
 * its own rather than a set of exports here is what makes that true of the
 * import graph and not only of the identifiers.
 *
 * ## Secrets
 *
 * The client secret is held in a closure, never on the returned object, never
 * in a log line, never in an error message, and never in a URL — it travels
 * only in a POST body to the provider's token endpoint. {@link redactSecret}
 * scrubs it out of any string derived from a failure as a second line of
 * defence, because "no code path currently interpolates it" is a property that
 * has to hold for every future edit, not just today's.
 *
 * The provider's own access token is treated the same way. It is used once, to
 * read the profile, and is never returned, stored or logged: what leaves this
 * module on success is a `ProviderIdentity` and nothing else. AgentChat has no
 * use for a GitHub token, so it does not keep one.
 *
 * @module
 */

import { ErrorCode, ProtocolError } from '@agentchat/protocol';
import { z } from 'zod';

import {
  DEFAULT_INTERVAL_SECONDS,
  type DeviceAuthorizationGrant,
  type DeviceAuthorizationOutcome,
  type IdentityProvider,
  type ProviderIdentity,
  SLOW_DOWN_INCREMENT_SECONDS,
} from './identity.js';

/** Where a device authorization is started. */
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';

/** Where a device code is exchanged for an access token. */
export const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Where the authenticated user's profile is read. */
export const GITHUB_USER_URL = 'https://api.github.com/user';

/**
 * Scopes requested for the device authorization.
 *
 * `read:user` and nothing else. The upsert needs an id, a login, a display name
 * and an email, all of which `GET /user` returns under this scope; `user:email`
 * would additionally expose every verified address on the account, which
 * AgentChat neither reads nor stores (plan §2: "Never used for delivery").
 * Asking for less is the whole of the security argument here.
 */
export const DEFAULT_SCOPE = 'read:user';

/** Longest a single call to the provider may take, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** What a redacted secret is replaced with, matching the logger's censor. */
const REDACTED = '[redacted]';

/** Identifies this server to the provider, per GitHub's API guidance. */
const USER_AGENT = 'agentchat-server';

/**
 * The shape of `fetch` this module uses.
 *
 * Injected so tests exercise the mapping without a socket: nothing in this
 * repository may talk to github.com during a test run.
 */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Endpoints, overridable for a GitHub Enterprise deployment or a test. */
export interface GitHubEndpoints {
  /** Device authorization endpoint. */
  readonly deviceCodeUrl: string;
  /** Token endpoint. */
  readonly accessTokenUrl: string;
  /** Profile endpoint. */
  readonly userUrl: string;
}

/** Options for {@link createGitHubIdentityProvider}. */
export interface GitHubIdentityProviderOptions {
  /** The OAuth app's client id. Public by design; it appears in no response. */
  readonly clientId: string;

  /**
   * The OAuth app's client secret, when the app is a confidential client.
   *
   * Optional because GitHub's device flow does not require one for an OAuth
   * app, while RFC 8628 §3.4 allows a confidential client to authenticate at
   * the token endpoint — and plan §7 lists `GITHUB_CLIENT_SECRET` as server
   * configuration. When present it is sent as a form field to the token
   * endpoint and nowhere else. It is never returned, logged, or included in an
   * error message.
   */
  readonly clientSecret?: string;

  /** Scopes to request. Defaults to {@link DEFAULT_SCOPE}. */
  readonly scope?: string;

  /** Endpoint overrides. Defaults to github.com. */
  readonly endpoints?: Partial<GitHubEndpoints>;

  /** HTTP client. Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;

  /** Per-call timeout in milliseconds. Defaults to {@link DEFAULT_REQUEST_TIMEOUT_MS}. */
  readonly requestTimeoutMs?: number;
}

/**
 * The device authorization response, as much of it as matters.
 *
 * Unknown fields are dropped rather than rejected: a provider adding one must
 * not break a login.
 */
const deviceCodeResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.url(),
  expires_in: z.int().positive(),
  interval: z.int().nonnegative().optional(),
});

/**
 * The token endpoint's response, which is either a token or an OAuth error.
 *
 * Parsed as one permissive object rather than a union so that a body carrying
 * neither field is a parse success with nothing in it, and is reported as a
 * provider fault by the one branch that handles it — rather than as a zod
 * failure whose message would name every alternative.
 */
const accessTokenResponseSchema = z.object({
  access_token: z.string().min(1).optional(),
  error: z.string().min(1).optional(),
  interval: z.int().nonnegative().optional(),
});

/**
 * The profile, as much of it as the `users` table stores.
 *
 * `id` accepts a string as well as a number because the column is `text` and
 * the plan is explicit that the subject is opaque; a provider that numbers its
 * users differently should not need a code change here.
 */
const userProfileSchema = z.object({
  id: z.union([z.int(), z.string().min(1)]),
  login: z.string().min(1),
  name: z.string().nullish(),
  email: z.string().nullish(),
});

/**
 * Removes the client secret from a string.
 *
 * Defence in depth. No code path below puts the secret into a message, but
 * every future edit would have to keep that true, and a leaked secret is not a
 * bug that can be fixed by a later release.
 *
 * @param text - A message about to be thrown or logged.
 * @param secret - The secret to remove, if there is one.
 * @returns `text` with every occurrence of `secret` replaced.
 */
function redactSecret(text: string, secret: string | undefined): string {
  return secret === undefined || secret === '' ? text : text.replaceAll(secret, REDACTED);
}

/**
 * The underlying failure, unless it names the secret.
 *
 * `app.ts` logs the whole error, and pino's serializer walks the `cause` chain,
 * so attaching a cause is attaching its message to the log. Scrubbing this
 * module's own message would be pointless if the value it removed travelled one
 * property away. A dropped stack trace costs a debugging session; a logged
 * client secret costs a rotation and an audit.
 *
 * @param cause - The failure that was caught.
 * @param secret - The secret to look for.
 * @returns `cause`, or `undefined` if it mentions the secret anywhere.
 */
function safeCause(cause: unknown, secret: string | undefined): unknown {
  if (secret === undefined || secret === '') {
    return cause;
  }

  const rendered =
    cause instanceof Error ? `${cause.message}\n${cause.stack ?? ''}` : String(cause);

  return rendered.includes(secret) ? undefined : cause;
}

/**
 * Reports a provider failure as the server's own.
 *
 * @param message - What went wrong. Reaches the log, never the client: `app.ts`
 *   answers every 500 with a fixed message.
 * @param cause - The underlying failure, if any.
 * @returns A `ProtocolError` carrying {@link ErrorCode.INTERNAL}.
 */
function providerFault(message: string, cause?: unknown): ProtocolError {
  return cause === undefined
    ? new ProtocolError(ErrorCode.INTERNAL, message)
    : new ProtocolError(ErrorCode.INTERNAL, message, { cause });
}

/**
 * Combines the caller's abort signal with this module's own timeout.
 *
 * A provider that accepts a connection and then says nothing would otherwise
 * hold a request open for as long as the platform's default allows, which is
 * long enough to exhaust the server's connections during an outage.
 */
function deadlineSignal(timeoutMs: number, signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
}

/**
 * Normalises the display name.
 *
 * The provider's name field is frequently null or blank; plan §2 requires the
 * login as the fallback, and `users_display_name_present` rejects the empty
 * string outright.
 */
function displayNameOf(name: string | null | undefined, login: string): string {
  const trimmed = name?.trim() ?? '';
  return trimmed === '' ? login : trimmed;
}

/**
 * Normalises the email.
 *
 * `UserSchema` promises `z.email().nullable()`, so anything that is not an
 * address becomes `null` rather than being stored and later failing to
 * serialise. A provider with no email for the account is the common case, not
 * an error.
 */
function emailOf(email: string | null | undefined): string | null {
  const trimmed = email?.trim() ?? '';
  return z.email().safeParse(trimmed).success ? trimmed : null;
}

/**
 * Creates the GitHub-backed {@link IdentityProvider}.
 *
 * @param options - Client credentials and overrides; see
 *   {@link GitHubIdentityProviderOptions}.
 * @returns A provider ready to broker logins. It holds no mutable state, so one
 *   instance serves the whole process.
 * @throws {ProtocolError} `INTERNAL` if `clientId` is blank, which is a
 *   configuration fault worth catching at startup rather than at first login.
 */
export function createGitHubIdentityProvider(
  options: GitHubIdentityProviderOptions,
): IdentityProvider {
  const clientId = options.clientId.trim();
  if (clientId === '') {
    throw providerFault('The identity provider has no client id configured.');
  }

  // Closed over rather than stored on the returned object: nothing can read it
  // back off the provider, and `JSON.stringify(provider)` cannot leak it.
  const clientSecret =
    options.clientSecret === undefined || options.clientSecret.trim() === ''
      ? undefined
      : options.clientSecret;

  const scope = options.scope ?? DEFAULT_SCOPE;
  const timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const http: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  const deviceCodeUrl = options.endpoints?.deviceCodeUrl ?? GITHUB_DEVICE_CODE_URL;
  const accessTokenUrl = options.endpoints?.accessTokenUrl ?? GITHUB_ACCESS_TOKEN_URL;
  const userUrl = options.endpoints?.userUrl ?? GITHUB_USER_URL;

  /** Scrubs the secret out of a message before it is thrown. */
  const safe = (text: string): string => redactSecret(text, clientSecret);

  /**
   * Performs one request and returns its status and parsed JSON body.
   *
   * A transport failure, a timeout and a body that is not JSON are all provider
   * faults; the status is returned rather than checked here because the token
   * endpoint reports OAuth errors with statuses that vary by provider.
   */
  async function request(
    url: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<{ status: number; body: unknown }> {
    let response: Response;
    try {
      response = await http(url, { ...init, signal: deadlineSignal(timeoutMs, signal) });
    } catch (cause: unknown) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw providerFault(
        safe(`The identity provider could not be reached: ${detail}`),
        safeCause(cause, clientSecret),
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (cause: unknown) {
      throw providerFault(
        safe(`The identity provider answered ${response.status} with a body that is not JSON.`),
        safeCause(cause, clientSecret),
      );
    }

    return { status: response.status, body };
  }

  /** The form body every token-endpoint call shares. */
  function credentials(): URLSearchParams {
    const form = new URLSearchParams({ client_id: clientId });
    if (clientSecret !== undefined) {
      // The one place the secret is used. Form body only: a query parameter
      // would be written to the provider's access log and to any proxy's.
      form.set('client_secret', clientSecret);
    }
    return form;
  }

  /** Headers for a form POST to the provider's OAuth endpoints. */
  function formHeaders(): Record<string, string> {
    return {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': USER_AGENT,
    };
  }

  /**
   * Reads the profile of whoever the provider's access token belongs to.
   *
   * The token is a parameter rather than a field: it lives for the duration of
   * this call and is then unreferenced.
   */
  async function readIdentity(
    accessToken: string,
    signal: AbortSignal | undefined,
  ): Promise<ProviderIdentity> {
    const { status, body } = await request(
      userUrl,
      {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${accessToken}`,
          'user-agent': USER_AGENT,
          'x-github-api-version': '2022-11-28',
        },
      },
      signal,
    );

    if (status < 200 || status >= 300) {
      throw providerFault(`The identity provider refused the profile request with ${status}.`);
    }

    const parsed = userProfileSchema.safeParse(body);
    if (!parsed.success) {
      throw providerFault('The identity provider returned a profile in an unexpected shape.');
    }

    const login = parsed.data.login.trim();

    return {
      subject: String(parsed.data.id),
      // Lowercased here, at the boundary, so every consumer gets the form the
      // `users` table and `@alice/backend` both require (plan §2).
      username: login.toLowerCase(),
      displayName: displayNameOf(parsed.data.name, login),
      email: emailOf(parsed.data.email),
    };
  }

  /**
   * Maps an OAuth error code onto an outcome.
   *
   * The four codes RFC 8628 §3.5 defines are ordinary states of a login and
   * each is answered differently by the caller. Everything else — a disabled
   * device flow, refused client credentials, an unsupported grant type — says
   * the *server's* OAuth app is wrong, which no client can act on and no
   * message should describe to one.
   */
  function outcomeForError(
    error: string,
    interval: number | undefined,
  ): DeviceAuthorizationOutcome {
    switch (error) {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return {
          status: 'slow_down',
          interval: Math.max(interval ?? 0, DEFAULT_INTERVAL_SECONDS + SLOW_DOWN_INCREMENT_SECONDS),
        };
      case 'access_denied':
        return { status: 'denied' };
      case 'expired_token':
        return { status: 'expired' };
      // Not an expiry as such, but indistinguishable from one to a caller: the
      // code the provider was given is not redeemable and the flow must start
      // again. Reported as the same terminal state rather than as a fault,
      // because a code that has already been redeemed can produce it.
      case 'incorrect_device_code':
        return { status: 'expired' };
      default:
        throw providerFault(`The identity provider rejected the token request: ${error}.`);
    }
  }

  return {
    async startDeviceAuthorization(signal?: AbortSignal): Promise<DeviceAuthorizationGrant> {
      const form = new URLSearchParams({ client_id: clientId, scope });

      const { status, body } = await request(
        deviceCodeUrl,
        { method: 'POST', headers: formHeaders(), body: form.toString() },
        signal,
      );

      if (status < 200 || status >= 300) {
        throw providerFault(`The identity provider refused to start a device flow (${status}).`);
      }

      const parsed = deviceCodeResponseSchema.safeParse(body);
      if (!parsed.success) {
        // The body is not echoed: it contains a live device code.
        throw providerFault(
          'The identity provider returned a device authorization in an unexpected shape.',
        );
      }

      return {
        deviceCode: parsed.data.device_code,
        userCode: parsed.data.user_code,
        verificationUri: parsed.data.verification_uri,
        // `DurationSecondsSchema` is a positive integer, so a provider stating
        // no interval — or zero — becomes the RFC's default rather than a
        // response the contract rejects.
        interval: Math.max(parsed.data.interval ?? 0, DEFAULT_INTERVAL_SECONDS),
        expiresIn: parsed.data.expires_in,
      };
    },

    async redeemDeviceAuthorization(
      deviceCode: string,
      signal?: AbortSignal,
    ): Promise<DeviceAuthorizationOutcome> {
      const form = credentials();
      form.set('device_code', deviceCode);
      form.set('grant_type', 'urn:ietf:params:oauth:grant-type:device_code');

      // The status is deliberately not checked before the body: RFC 8628 has
      // the token endpoint report `authorization_pending` with a 400, while
      // GitHub reports it with a 200. Both are ordinary states of a login, so
      // the body decides and the status is only consulted when the body says
      // nothing.
      const { status, body } = await request(
        accessTokenUrl,
        { method: 'POST', headers: formHeaders(), body: form.toString() },
        signal,
      );

      const parsed = accessTokenResponseSchema.safeParse(body);
      if (!parsed.success) {
        throw providerFault(
          'The identity provider returned a token response in an unexpected shape.',
        );
      }

      if (parsed.data.error !== undefined) {
        return outcomeForError(parsed.data.error, parsed.data.interval);
      }

      const accessToken = parsed.data.access_token;
      if (accessToken === undefined) {
        throw providerFault(
          `The identity provider answered ${status} with neither a token nor an error.`,
        );
      }

      return { status: 'approved', identity: await readIdentity(accessToken, signal) };
    },
  };
}
