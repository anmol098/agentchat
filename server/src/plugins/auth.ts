/**
 * Bearer authentication: who the caller is, and whether this route cares.
 *
 * The server has exactly one way to learn a caller's identity — an
 * `Authorization: Bearer <access token>` header, verified against the HS256
 * secret by {@link verifyAccessToken} (T-104). This module turns that into two
 * things a route can rely on: a `request.user` decorator, and a 401 that every
 * unauthenticated request to a protected route receives without the handler
 * being written at all.
 *
 * ## Routes are protected unless they say otherwise
 *
 * A route declares its stance in its own `config`:
 *
 * ```ts
 * app.get('/projects', handler);                                   // protected
 * app.get('/healthz', { config: { auth: 'public' } }, handler);     // not
 * ```
 *
 * **Omitting `auth` means `required`.** That is the whole safety argument for
 * this design, and it is worth stating plainly: the alternative — an allowlist
 * of protected routes, or a `preHandler` each route opts into — fails open. A
 * route added in a hurry, or copied from a public one, or renamed so it no
 * longer matches a prefix rule, would serve project data to anybody who asked,
 * and nothing about the route would look wrong in review. Here the same
 * omission yields a 401 on a route that should have been public: reported by
 * the first caller, fixed by adding one line. One failure mode is a bug report;
 * the other is a breach.
 *
 * Plan §3 fixes the whole unauthenticated surface — `/healthz`,
 * `/auth/device/*` and `/version` — so the strict default is also the common
 * case, and `auth: 'public'` reads as the deliberate exception it is. Each one
 * is logged as it is registered (see {@link registerAuth}) so that surface can
 * be read off a boot log rather than reconstructed by grepping route files.
 *
 * ## Every rejection looks the same
 *
 * No header, a header that is not a bearer credential, a token that is not a
 * JWT, a token signed with the wrong key, a token that expired an hour ago:
 * every one answers 401 with {@link ErrorCode.AUTH_REQUIRED},
 * {@link AUTH_REQUIRED_MESSAGE} and the same `WWW-Authenticate` challenge, byte
 * for byte. A verifier that distinguishes them is an oracle: feed it harvested
 * strings and the responses sort them into "never existed", "real but expired"
 * and "real and live", and the middle group is the one worth pairing with a
 * stolen refresh token. The reason is put in the thrown error's `cause` and
 * logged with the request id; it never crosses the wire.
 *
 * Nothing is lost by not distinguishing them, because the client's remedy is
 * the same in every case: refresh once, then `agentchat login`.
 *
 * ## Wiring
 *
 * `registerAuth` is a plain function called on the instance, like
 * `registerHealthRoutes`, rather than something `app.register()` loads: an
 * encapsulated plugin's decorators are invisible to routes registered on the
 * parent, and pulling in `fastify-plugin` to break that encapsulation is a
 * dependency this does not need.
 *
 * Calling it once on the root instance guards every route on that instance,
 * whether the route was registered before or after — Fastify assembles the hook
 * chain at ready time rather than at registration. That is asserted in the
 * tests, because the opposite is the natural guess and, if it were true, this
 * plugin could be wired into place and silently guard nothing.
 *
 * The WebSocket upgrade has a `?token=` fallback for clients that cannot set
 * headers (Plan §5). That belongs to the socket task, not here: accepting a
 * credential in a query string on an HTTP route would write it into every
 * access log and every browser history.
 *
 * @module
 */

import { ErrorCode, ProtocolError, type SessionId, type UserId } from '@agentchat/protocol';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  type AccessTokenClaims,
  MIN_JWT_SECRET_LENGTH,
  TokenServiceConfigurationError,
  verifyAccessToken,
} from '../auth/tokens.js';

/** One second, in milliseconds. Claims are whole seconds; `Date` is not. */
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * The one message every authentication failure carries.
 *
 * Deliberately silent about which of the several possible failures occurred;
 * see the module note. It names the remedy instead, which is the part that is
 * the same for all of them.
 */
export const AUTH_REQUIRED_MESSAGE =
  'This request requires a valid access token. Sign in again with: agentchat login';

/**
 * The `WWW-Authenticate` challenge sent with every 401 from this module.
 *
 * RFC 6750 §3 allows an `error="invalid_token"` parameter beside the scheme. It
 * is omitted on purpose: it would separate "you sent nothing" from "you sent
 * something that did not verify", which is exactly the distinction the uniform
 * message exists to withhold. A constant tells a well-behaved client which
 * scheme to use and tells a prober nothing.
 */
export const WWW_AUTHENTICATE_CHALLENGE = 'Bearer';

/**
 * `Authorization: Bearer <token>`.
 *
 * The scheme is matched case-insensitively because RFC 7235 says it is
 * case-insensitive. The credential is one run of visible ASCII: a JWT is
 * base64url and dots, so anything with a space, a control character or a
 * non-ASCII byte in it is not a token this server issued, and is rejected here
 * rather than handed to the verifier to reject less clearly.
 */
const BEARER_HEADER = /^bearer[ \t]+(?<token>[\x21-\x7e]+)[ \t]*$/i;

/**
 * What a route says about credentials.
 *
 * - `required` — the caller must present a valid access token. The default.
 * - `public` — no credentials are read and `request.user` stays `null`.
 *
 * There is deliberately no third option. "Optional" authentication — read the
 * token if one is offered, carry on if not — sounds harmless and is how a route
 * acquires two behaviours, only one of which anybody tests. A route that
 * genuinely serves both audiences is two routes, or one public route that looks
 * the caller up itself and owns that decision visibly.
 */
export type RouteAuthStance = 'required' | 'public';

/** The identity a verified access token asserts. */
export interface AuthenticatedUser {
  /** The AgentChat user, from the token's `sub` claim. */
  readonly id: UserId;

  /**
   * The session the token was minted inside, if it named one.
   *
   * Absent more often than not: `sid` is not preserved across a refresh (see
   * {@link AccessTokenClaims.sid}), so anything needing a session must resolve
   * it from the request rather than assume this is set.
   */
  readonly sessionId?: SessionId | undefined;

  /** When the token was issued. */
  readonly issuedAt: Date;

  /** When the token stops being accepted, before clock-skew tolerance. */
  readonly expiresAt: Date;
}

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The authenticated caller, or `null` on a public route.
     *
     * Nullable because the type must describe public routes too. On a protected
     * route it is never null by the time a handler runs — the request would
     * have been answered with a 401 first — so handlers should call
     * {@link FastifyRequest.requireUser} rather than write a null check that
     * can never be true and will therefore never be tested.
     */
    user: AuthenticatedUser | null;

    /**
     * The authenticated caller, asserted.
     *
     * @returns The verified identity.
     * @throws {ProtocolError} `INTERNAL` when called on a route that is not
     *   protected, which is a server bug rather than a caller's mistake.
     */
    requireUser(): AuthenticatedUser;
  }

  interface FastifyContextConfig {
    /**
     * How this route treats credentials. Omitting it means `required`; see the
     * module note on why the default is the strict one.
     */
    auth?: RouteAuthStance;
  }
}

/** Options for {@link registerAuth}. */
export interface AuthOptions {
  /**
   * The HS256 signing key, from `JWT_SECRET`. The same secret the token service
   * signs with — verification is symmetric, which is why there is one value and
   * not a pair.
   */
  readonly jwtSecret: string;

  /** Reads the current time. Injected so expiry is testable. */
  readonly now?: (() => Date) | undefined;
}

/**
 * Builds the one failure this module reports.
 *
 * @param reason - Internal detail, for the `cause` chain and the log. Never
 *   reaches the client.
 * @returns A `ProtocolError` carrying {@link ErrorCode.AUTH_REQUIRED}, which
 *   `errors.ts` maps to 401.
 */
function authRequired(reason: string): ProtocolError {
  return new ProtocolError(ErrorCode.AUTH_REQUIRED, AUTH_REQUIRED_MESSAGE, {
    cause: new Error(reason),
  });
}

/**
 * Extracts the credential from an `Authorization` header.
 *
 * @param header - The header exactly as it arrived, if it arrived at all.
 * @returns The token, or `undefined` when there is no usable bearer credential.
 */
function bearerTokenOf(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }

  return BEARER_HEADER.exec(header)?.groups?.['token'];
}

/**
 * The stance the matched route declared.
 *
 * `routeOptions.config` carries nothing for a request that matched no route,
 * which Fastify answers through the not-found handler. Those default to
 * protected like everything else: whether a URL exists is not something an
 * unauthenticated caller needs to be told, and a 404 only authenticated callers
 * can see is a smaller surface to map.
 */
function stanceOf(request: FastifyRequest): RouteAuthStance {
  return request.routeOptions.config?.auth ?? 'required';
}

/**
 * Turns verified claims into the identity handlers see.
 *
 * @param claims - Claims from a token whose signature and expiry already
 *   checked out.
 * @returns The value `request.user` is set to.
 */
function userOf(claims: AccessTokenClaims): AuthenticatedUser {
  const identity = {
    id: claims.sub,
    issuedAt: new Date(claims.iat * MILLISECONDS_PER_SECOND),
    expiresAt: new Date(claims.exp * MILLISECONDS_PER_SECOND),
  };

  // Spread rather than an always-present `sessionId: undefined`, because
  // `exactOptionalPropertyTypes` draws a real distinction between a property
  // that is absent and one that is present and undefined.
  return claims.sid === undefined ? identity : { ...identity, sessionId: claims.sid };
}

/**
 * Installs the `user` decorator and the authentication hook.
 *
 * Call it once, on the root instance, in `createApp`. Every route on that
 * instance is then guarded — including routes registered before this call and
 * routes in scopes encapsulated inside it — which is what makes "every route is
 * protected" a property of the application rather than of the routes somebody
 * remembered to annotate.
 *
 * The corollary is that adding this to `createApp` protects `/healthz` too, so
 * the routes Plan §3 lists as unauthenticated (`/healthz`, `/auth/device/*`,
 * `/version`) each need `config: { auth: 'public' }` in the same change.
 *
 * @param app - The instance to guard.
 * @param options - See {@link AuthOptions}.
 * @throws {TokenServiceConfigurationError} When the secret is too short to be
 *   worth verifying against. HMAC-SHA256 takes a key of any length and gives a
 *   weak one weak security in silence, so this is caught at startup or never.
 */
export function registerAuth(app: FastifyInstance, options: AuthOptions): void {
  const { jwtSecret } = options;
  const clock = options.now ?? (() => new Date());

  if (jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new TokenServiceConfigurationError(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters; ` +
        `the configured value is ${jwtSecret.length}. Generate one with: openssl rand -hex 32`,
    );
  }

  app.decorateRequest('user', null);

  app.decorateRequest('requireUser', function requireUser(this: FastifyRequest): AuthenticatedUser {
    if (this.user === null) {
      // Reachable only from a handler on a route that declared itself public.
      // That is a bug in the route, and a bug is a 500 rather than an
      // invitation for the caller to retry with credentials they have already
      // sent and that would change nothing.
      throw new ProtocolError(
        ErrorCode.INTERNAL,
        `Route ${this.method} ${this.url} asked for the authenticated user but is not protected.`,
      );
    }

    return this.user;
  });

  // The unauthenticated surface, readable from a boot log. The one real risk of
  // an opt-out scheme is an opt-out nobody notices in review; this makes each
  // of them say so out loud, once, where an operator will see it.
  //
  // Unlike `onRequest`, `onRoute` only fires for routes registered after this
  // call — it is a registration-time notification, not part of a request's hook
  // chain. Calling `registerAuth` first in `createApp`, which is where it
  // belongs anyway, is what makes the list complete.
  app.addHook('onRoute', (route) => {
    if (route.config?.auth === 'public') {
      app.log.info(
        { method: route.method, url: route.url },
        'route registered without authentication',
      );
    }
  });

  app.addHook('onRequest', (request, reply, done) => {
    if (stanceOf(request) === 'public') {
      done();
      return;
    }

    // Set before the reason is known, so the response to a missing header and
    // the response to a forged token are identical in their headers as well as
    // in their body.
    void reply.header('www-authenticate', WWW_AUTHENTICATE_CHALLENGE);

    const token = bearerTokenOf(request.headers.authorization);
    if (token === undefined) {
      done(reject(request, 'no bearer credential in the authorization header'));
      return;
    }

    let claims: AccessTokenClaims;
    try {
      claims = verifyAccessToken(token, jwtSecret, clock());
    } catch (error: unknown) {
      // `verifyAccessToken` already answers every failure identically. It is
      // re-wrapped rather than rethrown so that the uniformity is a property of
      // this module too, and does not quietly become a property of whatever
      // that function is changed into later.
      done(reject(request, reasonOf(error)));
      return;
    }

    request.user = userOf(claims);
    done();
  });
}

/**
 * The most specific account of why a token was refused.
 *
 * `verifyAccessToken` gives every failure the same client-facing message and
 * puts the actual reason — `expired`, `signature mismatch`, `malformed
 * payload` — in the `cause`. That split is the whole design: the caller reads
 * the message, the operator reads the cause. Logging the outer message would
 * record the same uninformative sentence for every distinct failure and quietly
 * throw away the only diagnostic there is.
 *
 * @param error - Whatever verification threw.
 * @returns A short reason for the log. Never empty, never the credential.
 */
function reasonOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'access token rejected';
  }

  if (error.cause instanceof Error && error.cause.message !== '') {
    return error.cause.message;
  }

  return error.message === '' ? 'access token rejected' : error.message;
}

/**
 * Records why a request was refused, then builds the answer that says nothing
 * about it.
 *
 * The log line is the operator's half of the split: `app.ts` logs the error
 * itself with the request id, and this adds the reason as a plain field so it
 * survives whatever the serializer does with a `cause` chain. Only the reason
 * is logged — never the header, which is the credential.
 *
 * @param request - The request being refused, for its logger and request id.
 * @param reason - Internal detail. Never sent.
 * @returns The failure to hand to Fastify.
 */
function reject(request: FastifyRequest, reason: string): ProtocolError {
  request.log.info({ reason }, 'authentication rejected');
  return authRequired(reason);
}
