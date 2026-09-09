/**
 * The one thing this suite is allowed to fake, and the reason it is allowed.
 *
 * Everything else in `tests/e2e` is the software this project ships: the built
 * server running as its own process against a real PostgreSQL, the built
 * `agentchat` binary running as its own process, real HTTP and a real
 * WebSocket. That is the whole point of the suite — see the module note in
 * `./harness.ts`.
 *
 * The identity provider is the exception, because nobody can approve a device
 * authorization in a test. RFC 8628 is a flow whose middle step is *a human
 * opening a browser and typing a code*; there is no headless variant of that,
 * and a test that waited for one would never finish.
 *
 * So this module is a GitHub-shaped device-flow provider on loopback. It
 * implements the three endpoints `server/src/auth/github.ts` calls:
 *
 * ```text
 * POST /login/device/code           the device authorization request
 * POST /login/oauth/access_token    the token request
 * GET  /user                        the profile
 * ```
 *
 * ## What is still real, and why that matters
 *
 * The server's own GitHub adapter is **not** replaced. `createGitHubIdentityProvider`
 * runs unmodified in the server process: it builds the form bodies, sets the
 * headers, parses the responses against its zod schemas, normalises the display
 * name and the email, and maps OAuth errors onto
 * `DeviceAuthorizationOutcome`. What this module replaces is the *host* those
 * requests go to, and nothing else. See `./github-redirect.mjs` for how that
 * one substitution is made.
 *
 * The consequence worth stating plainly: a change that broke the adapter's
 * request shape, its response parsing, or its outcome mapping would fail this
 * suite. A change that broke github.com would not, which is correct — that is
 * not a regression in this repository.
 *
 * ## Approval is immediate, and deliberately so
 *
 * The token endpoint answers `access_token` on the first poll rather than
 * making the client wait through an `authorization_pending`. The pending path
 * has its own coverage in `server/src/routes/auth.test.ts` and
 * `packages/cli/src/commands/auth.test.ts`, both of which can drive it without
 * a clock. Repeating it here would buy nothing and would add seconds to every
 * `beforeAll` in the suite.
 *
 * A login still costs about five seconds of real waiting, and that is not this
 * module's choice to make. `server/src/auth/github.ts` raises whatever interval
 * a provider advertises to at least `DEFAULT_INTERVAL_SECONDS`, which RFC 8628
 * §3.2 fixes at five, and the server then refuses a poll made before
 * `start + interval`. Advertising one second here changes nothing; the value
 * below says five because that is what actually happens, and a number that
 * claimed otherwise would have somebody hunting for the missing four seconds.
 *
 * ## Identities are queued, not guessed
 *
 * Each login must become a specific, known user, so {@link FakeIdentityProvider.enqueue}
 * names who the *next* device authorization belongs to. Logins in this suite
 * are sequential for that reason. A request that arrives with the queue empty
 * gets a generated identity rather than an error, so a stray poll cannot wedge
 * a test in a way that reads as an authentication bug.
 *
 * @module
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The device-authorization endpoint, on GitHub's path. */
const DEVICE_CODE_PATH = '/login/device/code';

/** The token endpoint, on GitHub's path. */
const ACCESS_TOKEN_PATH = '/login/oauth/access_token';

/** The profile endpoint, on GitHub's path (`api.github.com` in production). */
const USER_PATH = '/user';

/**
 * Seconds a client is told to wait between polls.
 *
 * Five, because five is what the server will use whatever this says: its
 * adapter takes `Math.max(advertised, DEFAULT_INTERVAL_SECONDS)`. Stating the
 * effective value keeps the fake honest about the flow it is standing in for.
 */
const POLL_INTERVAL_SECONDS = 5;

/**
 * How long an idle connection to this fake is held open, in milliseconds.
 *
 * Node's default is five seconds, which is exactly the poll interval above — so
 * the default would put this fake's own connection reuse in a race with the
 * flow it exists to serve, and a login would occasionally fail for a reason
 * that lives entirely inside the test harness. A long timeout removes the fake
 * from that question; every connection is dropped at {@link FakeIdentityProvider.close}
 * regardless.
 */
const IDLE_CONNECTION_TIMEOUT_MS = 300_000;

/** Seconds a device code stays redeemable. Long enough that no test races it. */
const DEVICE_CODE_LIFETIME_SECONDS = 900;

/** Base for parsing a request target. Never dereferenced. */
const REQUEST_URL_BASE = 'http://identity.invalid';

/**
 * A person, in the shape `server/src/auth/github.ts` parses.
 *
 * The field names are the provider's, not this project's: `id`, `login`,
 * `name`, `email` is what `userProfileSchema` reads. Anything else would be
 * testing a translation nobody performs.
 */
export interface ProviderProfile {
  /** The provider's stable subject. Stored as `users.github_id`. */
  readonly id: string;
  /** The handle. Becomes the AgentChat username, lowercased by the adapter. */
  readonly login: string;
  /** Display name, or `null` to make the adapter fall back to `login`. */
  readonly name: string | null;
  /** Primary email, or `null`. */
  readonly email: string | null;
}

/** A running fake provider. */
export interface FakeIdentityProvider {
  /**
   * Where it listens, e.g. `http://127.0.0.1:53210`.
   *
   * Handed to the server process as `AGENTCHAT_E2E_IDENTITY_ORIGIN`, which
   * `./github-redirect.mjs` reads.
   */
  readonly origin: string;

  /** Names the profile the next device authorization resolves to. */
  enqueue(profile: ProviderProfile): void;

  /** How many device authorizations have been started. */
  authorizationCount(): number;

  /** Stops listening and drops every connection. */
  close(): Promise<void>;
}

/** Reads a whole request body as UTF-8. */
async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Answers with JSON, which is what both of GitHub's OAuth endpoints do here. */
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(encoded)),
  });
  response.end(encoded);
}

/** Strips `Bearer ` or `token ` from an authorization header. */
function bearerOf(header: string | undefined): string {
  return (header ?? '').replace(/^(?:bearer|token)\s+/i, '').trim();
}

/**
 * Starts the fake provider on a loopback port the operating system chooses.
 *
 * @returns The running provider. The caller owns it and must `close()` it.
 */
export async function startIdentityProvider(): Promise<FakeIdentityProvider> {
  /** Profiles named for the next authorizations, oldest first. */
  const queued: ProviderProfile[] = [];
  /** Device code to the profile it will resolve to. */
  const profileByDeviceCode = new Map<string, ProviderProfile>();
  /** Access token to the profile it identifies. */
  const profileByAccessToken = new Map<string, ProviderProfile>();

  let started = 0;

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? '/', REQUEST_URL_BASE);
    const body = await readBody(request);

    if (request.method === 'POST' && url.pathname === DEVICE_CODE_PATH) {
      started += 1;
      const deviceCode = `device-code-${String(started)}`;
      const profile = queued.shift() ?? {
        id: `900${String(started)}`,
        login: `unqueued${String(started)}`,
        name: null,
        email: null,
      };
      profileByDeviceCode.set(deviceCode, profile);

      sendJson(response, 200, {
        device_code: deviceCode,
        user_code: `E2E-${String(started).padStart(4, '0')}`,
        // A real address rather than a placeholder: the CLI prints it, and a
        // malformed one would fail the adapter's `z.url()` before any test ran.
        verification_uri: 'https://example.invalid/device',
        expires_in: DEVICE_CODE_LIFETIME_SECONDS,
        interval: POLL_INTERVAL_SECONDS,
      });
      return;
    }

    if (request.method === 'POST' && url.pathname === ACCESS_TOKEN_PATH) {
      const deviceCode = new URLSearchParams(body).get('device_code') ?? '';
      const profile = profileByDeviceCode.get(deviceCode);
      if (profile === undefined) {
        // GitHub answers OAuth errors with 200 and an `error` field, which is
        // the case `github.ts` documents as the one that varies by provider.
        sendJson(response, 200, { error: 'expired_token' });
        return;
      }

      const accessToken = `access-token-${deviceCode}`;
      profileByAccessToken.set(accessToken, profile);
      sendJson(response, 200, { access_token: accessToken, token_type: 'bearer', scope: '' });
      return;
    }

    if (request.method === 'GET' && url.pathname === USER_PATH) {
      const profile = profileByAccessToken.get(bearerOf(request.headers.authorization));
      if (profile === undefined) {
        sendJson(response, 401, { message: 'Bad credentials' });
        return;
      }
      sendJson(response, 200, profile);
      return;
    }

    sendJson(response, 404, { message: 'Not Found' });
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(response, 500, { message: 'fake identity provider failed' });
      }
    });
  });

  server.keepAliveTimeout = IDLE_CONNECTION_TIMEOUT_MS;
  server.headersTimeout = IDLE_CONNECTION_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    enqueue(profile: ProviderProfile): void {
      queued.push(profile);
    },
    authorizationCount(): number {
      return started;
    },
    close(): Promise<void> {
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
