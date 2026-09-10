/**
 * The authentication plugin, tested through the real application.
 *
 * Every case here goes through `createAppShell`, so what is asserted is the response
 * a client actually receives — status, envelope, headers — rather than what the
 * hook hands to Fastify. Two properties are the point:
 *
 * 1. **A route that says nothing is protected.** `/omits-its-stance` declares no
 *    `auth` config at all, which is the mistake this design exists to make
 *    safe, and it answers 401 rather than serving.
 * 2. **Every rejection is byte-identical.** `rejections are indistinguishable`
 *    collects the response to a missing header, a malformed one, a token that
 *    is not a JWT, one signed with the wrong key and an expired one, and
 *    asserts they cannot be told apart. Anything that separates them turns this
 *    endpoint into an oracle for sorting harvested credentials.
 *
 * The 401 envelope assertion here also closes the one gap in
 * `server/tests/error-contract.test.ts`: that suite sweeps 400, 403, 404, 413,
 * 415 and 500, but nothing in the app could produce a 401 until this plugin
 * existed.
 */

import { ErrorCode, ErrorCodeSchema, SessionId, UserId } from '@stackgrid/protocol';
import type { FastifyInstance } from 'fastify';
import pino, { type Logger } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { createAppShell, REQUEST_ID_HEADER } from '../app.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  MIN_JWT_SECRET_LENGTH,
  signAccessToken,
  TokenServiceConfigurationError,
} from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { INTERNAL_ERROR_MESSAGE } from '../errors.js';
import type { HealthProbe } from '../routes/health.js';
import {
  AUTH_REQUIRED_MESSAGE,
  PUBLIC_SURFACE_CONFIRMED_MESSAGE,
  PUBLIC_SURFACE_INCOMPLETE_MESSAGE,
  registerAuth,
  WWW_AUTHENTICATE_CHALLENGE,
} from './auth.js';

/** The signing key under test. Long enough to be accepted; otherwise arbitrary. */
const SECRET = 'a'.repeat(MIN_JWT_SECRET_LENGTH);

/** A second, valid key nothing under test signs with. */
const OTHER_SECRET = 'b'.repeat(MIN_JWT_SECRET_LENGTH);

/** Fixed clock, so an expiry is a decision rather than a race. */
const NOW = new Date('2026-09-08T12:00:00.000Z');

/** `NOW` in whole seconds, which is the unit the claims use. */
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);

const USER = UserId.generate();
const SESSION = SessionId.generate();

const config: ServerConfig = loadConfig({
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  LOG_LEVEL: 'silent',
  // Required since T-019. `JWT_SECRET` is deliberately *not* SECRET: this suite
  // registers the plugin itself, with its own key and its own clock, on the
  // shell rather than on `createApp`.
  JWT_SECRET: 'j'.repeat(MIN_JWT_SECRET_LENGTH),
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
});

/** A probe that always says the database is fine; nothing here queries it. */
const reachable: HealthProbe = { ping: () => Promise.resolve() };

/** Log lines captured from the app under test, one JSON object per entry. */
type LogLine = Record<string, unknown>;

/** Builds a logger that keeps its output for inspection instead of printing it. */
function capturingLogger(sink: LogLine[]): Logger {
  return pino(
    { level: 'info', redact: { paths: ['req.headers.authorization'], censor: '[redacted]' } },
    {
      write: (line: string) => {
        sink.push(JSON.parse(line) as LogLine);
      },
    },
  );
}

const started: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0).map((app) => app.close()));
});

/** Options for {@link buildApp}. */
interface AppUnderTest {
  /** The instance, with the routes below registered. */
  readonly app: FastifyInstance;
  /** Everything the app logged, in order. */
  readonly logs: LogLine[];
}

/**
 * Builds the application with one route per stance a route can take.
 *
 * `registerAuth` runs after `createAppShell` has registered `/healthz` and
 * before the routes below, which proves incidentally that registration order
 * does not decide what is guarded: both sides of the call are reached by the
 * hook. The shell rather than `createApp` because `createApp` registers this
 * plugin itself (T-019), and a second `registerAuth` on one instance is a
 * duplicate decorator.
 */
function buildApp(now: () => Date = () => NOW): AppUnderTest {
  const logs: LogLine[] = [];
  const app = createAppShell({ config, database: reachable, logger: capturingLogger(logs) });
  started.push(app);

  registerAuth(app, { jwtSecret: SECRET, now });

  // The case this design is built around: a route whose author never thought
  // about authentication at all.
  app.get('/omits-its-stance', (request) => ({ userId: request.requireUser().id }));

  app.get('/protected', { config: { auth: 'required' } }, (request) => {
    const user = request.requireUser();
    return { userId: user.id, sessionId: user.sessionId ?? null };
  });

  app.get('/open', { config: { auth: 'public' } }, (request) => ({ user: request.user }));

  // A public route whose handler asks for a user anyway: a server bug, and the
  // one thing `requireUser` exists to turn into a 500 rather than a `null`
  // dereference three frames later.
  app.get('/open-but-asks', { config: { auth: 'public' } }, (request) => request.requireUser());

  return { app, logs };
}

/** Mints a token this server should accept. */
function validToken(claims: { sid?: SessionId } = {}): string {
  const base = {
    sub: USER,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + ACCESS_TOKEN_TTL_SECONDS,
  };

  return signAccessToken(claims.sid === undefined ? base : { ...base, sid: claims.sid }, SECRET);
}

/** A token that was valid, signed correctly, and is now well past its expiry. */
function expiredToken(): string {
  const expiredAt = NOW_SECONDS - CLOCK_SKEW_TOLERANCE_SECONDS - 1;

  return signAccessToken(
    { sub: USER, iat: expiredAt - ACCESS_TOKEN_TTL_SECONDS, exp: expiredAt },
    SECRET,
  );
}

/** A well-formed, unexpired token signed with somebody else's key. */
function forgedToken(): string {
  return signAccessToken(
    { sub: USER, iat: NOW_SECONDS, exp: NOW_SECONDS + ACCESS_TOKEN_TTL_SECONDS },
    OTHER_SECRET,
  );
}

describe('a route is protected unless it declares otherwise', () => {
  it('refuses a route that declared no stance at all', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/omits-its-stance' });

    // The whole safety argument, in one assertion: forgetting to declare fails
    // closed. An allowlist design would answer 200 here.
    expect(response.statusCode).toBe(401);
  });

  it('serves a route that declared no stance once credentials arrive', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/omits-its-stance',
      headers: { authorization: `Bearer ${validToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: USER });
  });

  it('serves a public route with no credentials at all', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/open' });

    expect(response.statusCode).toBe(200);
    // Public means the caller is not identified, not that identification is
    // attempted and forgiven.
    expect(response.json()).toEqual({ user: null });
  });

  it('ignores credentials offered to a public route', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/open',
      headers: { authorization: `Bearer ${validToken()}` },
    });

    expect(response.json()).toEqual({ user: null });
  });

  it('records each public route as it is registered', async () => {
    const { app, logs } = buildApp();
    await app.ready();

    const announced = logs
      .filter((line) => line['msg'] === 'route registered without authentication')
      .map((line) => line['url']);

    expect(announced).toEqual(expect.arrayContaining(['/open', '/open-but-asks']));
    expect(announced).not.toContain('/protected');
    expect(announced).not.toContain('/omits-its-stance');
  });
});

/**
 * The `onReady` reconciliation (T-058).
 *
 * The per-route lines above are emitted from an `onRoute` hook, which fires
 * only for routes registered after `registerAuth`. Beside a declaration naming
 * routes registered before it, that reads as a claim those routes are missing.
 * On the real server they are `/healthz` and `/version`, both of which answer
 * 200, and the misreading was filed as a production outage.
 *
 * Three things have to hold, and the third is the one that makes this a fix
 * rather than a rewording: a route that is declared and genuinely served by
 * nothing must not look like a route that is merely registered early.
 */
describe('the declared unauthenticated surface is reconciled at ready', () => {
  /**
   * A shell with one public route registered before the guard and one after,
   * plus whatever the caller declares.
   *
   * `/healthz` comes from the shell and is registered before `registerAuth`
   * too, so declaring it exercises the real ordering rather than a contrived
   * one.
   */
  function buildDeclaring(declared: readonly string[]): AppUnderTest {
    const logs: LogLine[] = [];
    const app = createAppShell({ config, database: reachable, logger: capturingLogger(logs) });
    started.push(app);

    app.get('/open-first', { config: { auth: 'public' } }, () => ({ ok: true }));

    registerAuth(app, {
      jwtSecret: SECRET,
      now: () => NOW,
      declaredPublicRoutes: new Set(declared),
    });

    app.get('/open-later', { config: { auth: 'public' } }, () => ({ ok: true }));

    return { app, logs };
  }

  /** The one reconciliation record, whichever level it was logged at. */
  function reportIn(logs: LogLine[]): LogLine | undefined {
    return logs.find(
      (line) =>
        line['msg'] === PUBLIC_SURFACE_CONFIRMED_MESSAGE ||
        line['msg'] === PUBLIC_SURFACE_INCOMPLETE_MESSAGE,
    );
  }

  it('names a public route the per-route lines could not see', async () => {
    const { app, logs } = buildDeclaring(['/healthz', '/open-first', '/open-later']);
    await app.ready();

    const announced = logs
      .filter((line) => line['msg'] === 'route registered without authentication')
      .map((line) => line['url']);

    // The premise: two of the three declared routes registered before the hook
    // existed, so no per-route line names them. That is the gap.
    expect(announced).not.toContain('/healthz');
    expect(announced).not.toContain('/open-first');

    // And the fix: the reconciliation names them, and says why they were
    // absent above rather than leaving the reader to guess between "registered
    // early" and "not registered at all".
    expect(reportIn(logs)).toMatchObject({
      msg: PUBLIC_SURFACE_CONFIRMED_MESSAGE,
      registeredBeforeGuard: ['GET /healthz', 'GET /open-first'],
      registeredAfterGuard: ['GET /open-later'],
      servedByNothing: [],
    });
  });

  it('reports a declared route that nothing registers, and does so at error level', async () => {
    const { app, logs } = buildDeclaring(['/healthz', '/open-later', '/promised-but-absent']);
    await app.ready();

    const report = reportIn(logs);

    // The case the old log could not express at all: identical to the healthy
    // one, because both showed up as silence. A route the deployment promised
    // would answer without credentials and that answers 404 breaks every client
    // that has not logged in yet, so it is an error and it is named.
    expect(report).toMatchObject({
      msg: PUBLIC_SURFACE_INCOMPLETE_MESSAGE,
      servedByNothing: ['/promised-but-absent'],
    });
    expect(report?.['level']).toBe(pino.levels.values['error']);
  });

  it('does not mistake a route pattern that merely matches for a registered one', async () => {
    const logs: LogLine[] = [];
    const app = createAppShell({ config, database: reachable, logger: capturingLogger(logs) });
    started.push(app);

    registerAuth(app, {
      jwtSecret: SECRET,
      now: () => NOW,
      declaredPublicRoutes: new Set(['/things/refresh']),
    });

    // A parameterised route a request for `/things/refresh` would match. The
    // lookup is of a registered *pattern*, not of a request path, so this must
    // not be mistaken for the declared route being served.
    app.get('/things/:id', { config: { auth: 'public' } }, () => ({ ok: true }));

    await app.ready();

    expect(reportIn(logs)).toMatchObject({
      msg: PUBLIC_SURFACE_INCOMPLETE_MESSAGE,
      servedByNothing: ['/things/refresh'],
    });
  });

  it('says nothing when no surface was declared', async () => {
    const { app, logs } = buildApp();
    await app.ready();

    // A test hosting one route module has no declared surface, and a
    // reconciliation there would report every route it did not register as
    // missing. Silence is the honest answer, and the per-route lines still fire.
    expect(reportIn(logs)).toBeUndefined();
  });
});

describe('the hook guards the whole instance, not only what follows it', () => {
  it('guards a route that was registered before registerAuth ran', async () => {
    const logs: LogLine[] = [];
    const app = createAppShell({ config, database: reachable, logger: capturingLogger(logs) });
    started.push(app);

    app.get('/registered-first', () => ({ ok: true }));
    registerAuth(app, { jwtSecret: SECRET, now: () => NOW });

    const response = await app.inject({ method: 'GET', url: '/registered-first' });

    // Worth asserting rather than assuming, because the obvious guess is the
    // other one: a hook added after a route sounds like it should miss it.
    // Fastify assembles the root instance's hook chain at ready time, so
    // registration order does not decide what is guarded — which removes the
    // one way this plugin could be wired into place and silently do nothing.
    expect(response.statusCode).toBe(401);
  });

  it('reaches a route somebody else already wrote, which is the point', async () => {
    const { app } = buildApp();

    // `/healthz` comes from `createAppShell` and knows nothing about this
    // module. The hook still decides its stance: the shell declares it public
    // (Plan §3 puts it on the unauthenticated list), so it answers rather than
    // 401. Until T-019 wired that declaration this asserted the opposite, which
    // is the same fact seen from the other side — a route registered before
    // `registerAuth` is governed by it either way, and only its own `config`
    // says which way.
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok' } });
  });

  it('answers an unmatched route without saying whether it exists', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/no-such-route' });

    // 401 rather than 404: Fastify runs the instance's `onRequest` hooks before
    // deciding a request matched nothing, so an unauthenticated caller cannot
    // use 404-versus-401 to map which URLs this server serves. `stanceOf`
    // defaults a request with no route context to `required` for exactly this.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: ErrorCode.AUTH_REQUIRED, message: AUTH_REQUIRED_MESSAGE },
    });
  });
});

describe('a valid access token identifies the caller', () => {
  it('exposes the subject through the decorator', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${validToken()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ userId: USER, sessionId: null });
  });

  it('carries the session claim when the token has one', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${validToken({ sid: SESSION })}` },
    });

    expect(response.json()).toEqual({ userId: USER, sessionId: SESSION });
  });

  it('accepts the scheme in any case, as RFC 7235 requires', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `bEaReR   ${validToken()}` },
    });

    expect(response.statusCode).toBe(200);
  });

  it('does not leak the credential into the log', async () => {
    const { app, logs } = buildApp();
    const token = validToken();

    await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(JSON.stringify(logs)).not.toContain(token);
  });
});

/** One way to fail authentication, and a name for it. */
const REJECTIONS: readonly { readonly name: string; readonly header?: string }[] = [
  { name: 'no authorization header' },
  { name: 'an empty authorization header', header: '' },
  { name: 'a scheme that is not bearer', header: 'Basic dXNlcjpwYXNz' },
  { name: 'a bearer scheme with no credential', header: 'Bearer' },
  { name: 'a scheme run together with its credential', header: 'Bearerabc.def.ghi' },
  { name: 'a credential containing a space', header: 'Bearer abc def' },
  { name: 'a credential that is not a JWT at all', header: 'Bearer not-a-token' },
  { name: 'a JWT with a mangled payload', header: 'Bearer eyJhbGciOiJIUzI1NiJ9.!!!.sig' },
];

describe('every rejection tells the caller the same thing', () => {
  it.each(REJECTIONS)('refuses $name', async ({ header }) => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      ...(header === undefined ? {} : { headers: { authorization: header } }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      error: { code: ErrorCode.AUTH_REQUIRED, message: AUTH_REQUIRED_MESSAGE },
    });
  });

  it('refuses an expired token', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${expiredToken()}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses a token signed with the wrong key', async () => {
    const { app } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${forgedToken()}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('cannot be used to tell one kind of bad token from another', async () => {
    const { app } = buildApp();

    // Missing, malformed, unparseable, forged, and genuinely expired. The last
    // two are the pair that matters: an attacker holding a pile of harvested
    // strings must not be able to sort the real-but-stale ones out of it.
    const headers = [
      undefined,
      'Basic dXNlcjpwYXNz',
      'Bearer not-a-token',
      `Bearer ${forgedToken()}`,
      `Bearer ${expiredToken()}`,
    ];

    const answers = await Promise.all(
      headers.map(async (header) => {
        const response = await app.inject({
          method: 'GET',
          url: '/protected',
          ...(header === undefined ? {} : { headers: { authorization: header } }),
        });

        return {
          statusCode: response.statusCode,
          body: response.body,
          challenge: response.headers['www-authenticate'],
        };
      }),
    );

    // Every distinguishable part of the response, compared as a whole. A future
    // change that adds a hint to one branch fails here.
    for (const answer of answers) {
      expect(answer).toEqual(answers[0]);
    }
  });

  it('challenges with a constant, so the header is no oracle either', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/protected' });

    // No `error="invalid_token"`: that parameter would separate "sent nothing"
    // from "sent something wrong", which is the distinction being withheld.
    expect(response.headers['www-authenticate']).toBe(WWW_AUTHENTICATE_CHALLENGE);
  });

  it('answers with the protocol envelope and a quotable request id', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/protected' });
    const body = response.json<{ error: { code: string; message: string } }>();

    // The 401 arm of the error contract, which nothing in the app could reach
    // before this plugin existed.
    expect(Object.keys(body)).toEqual(['error']);
    expect(ErrorCodeSchema.safeParse(body.error.code).success).toBe(true);
    expect(body.error.code).toBe(ErrorCode.AUTH_REQUIRED);
    expect(response.headers[REQUEST_ID_HEADER]).toBeDefined();
  });

  it('logs why, with the request id, while saying nothing on the wire', async () => {
    const { app, logs } = buildApp();

    const response = await app.inject({
      method: 'GET',
      url: '/protected',
      headers: { authorization: `Bearer ${expiredToken()}` },
    });

    const rejection = logs.find((line) => line['msg'] === 'authentication rejected');

    expect(rejection?.['reason']).toBe('expired');
    expect(rejection?.['reqId']).toBe(response.headers[REQUEST_ID_HEADER]);
    // The operator's view and the caller's view share only the request id.
    expect(response.body).not.toContain('expired');
  });
});

describe('requireUser', () => {
  it('is a 500, not a 401, when a public route asks for a user', async () => {
    const { app } = buildApp();

    const response = await app.inject({ method: 'GET', url: '/open-but-asks' });

    // The caller did nothing wrong and has nothing to retry, so telling them to
    // log in would be a lie. It is a bug in the route, and it is reported as
    // one — without saying which route or why.
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: { code: ErrorCode.INTERNAL, message: INTERNAL_ERROR_MESSAGE },
    });
    expect(response.body).not.toContain('/open-but-asks');
  });
});

describe('registerAuth refuses a secret it will not verify against', () => {
  it('rejects a secret below the minimum length', () => {
    const { app } = buildApp();

    expect(() => registerAuth(app, { jwtSecret: 'short' })).toThrow(TokenServiceConfigurationError);
  });

  it('names the variable and the remedy', () => {
    const { app } = buildApp();

    expect(() => registerAuth(app, { jwtSecret: 'short' })).toThrow(/JWT_SECRET.*openssl rand/s);
  });
});
