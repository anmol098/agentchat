/**
 * `GET /version` — what this server is, and the oldest client it will serve.
 *
 * This is the endpoint a stranger's self-hosted server uses to tell a CLI it
 * has never met that the two of them cannot talk. It therefore has to work when
 * almost nothing else does, and every decision below follows from that.
 *
 * ## It has no dependencies, deliberately
 *
 * The handler reads three constants and returns them. No database, no
 * authentication, no service, no configuration. That is not minimalism for its
 * own sake — it is the difference between "the server is misconfigured" and
 * "the server is unreachable", which is the first question anyone debugging a
 * deployment has to answer.
 *
 * `GET /healthz` next door deliberately does the opposite: it runs a real query
 * because a load balancer needs to know whether this process can do its job. If
 * `/version` did the same, a server with a broken `DATABASE_URL` would answer
 * both endpoints with a failure and a user would have no way to tell a bad
 * database from a bad URL, a proxy in the way, or a client too old to be
 * served. So the two answer different questions on purpose: `/healthz` says
 * "can I work", `/version` says "am I an AgentChat server, and will I talk to
 * you". A server mid-migration, or with its database down, still answers this
 * one — and `agentchat version --server …` and `agentchat status` still tell a
 * self-hoster something true.
 *
 * The cost is that the numbers are compiled in rather than read from anywhere,
 * which is exactly the CLI's argument for {@link SERVER_VERSION} being a
 * constant. `./version.test.ts` fails the build if it ever disagrees with
 * `server/package.json`.
 *
 * ## Two halves of one negotiation, wired by one line
 *
 * {@link registerVersionRoutes} registers the route **and** the guard that
 * refuses a client below the floor. Those are not two features that happen to
 * live together: a `/version` endpoint with no guard reports a floor nothing
 * enforces, and a guard with no `/version` refuses callers who have no way to
 * discover what to upgrade to. This repository has repeatedly found that
 * half-wiring is worse than not wiring, so the two are not separately wireable.
 *
 * ## Nothing here assumes the protocol number is fixed
 *
 * `PROTOCOL_VERSION` is 3 today and there is an open question about resetting
 * it before the first release. Nothing in this module compares it, branches on
 * it, or restates it — it is read from `@stackgrid/protocol` and put on the
 * wire. The same is true of the floor: {@link VersionRouteOptions} takes all
 * three numbers so a test can move any of them without editing this file, and
 * the guard's arithmetic is `isClientTooOld`, which is semver comparison rather
 * than a string ordering that would call `0.10.0` older than `0.9.0`.
 *
 * ## What this module does not do
 *
 * The WebSocket upgrade is a raw `upgrade` listener rather than a Fastify route
 * (see `registerWebSocketEndpoint` in `app.ts`), so no `onRequest` hook runs
 * for it and the guard below does not cover it. The `hello` frame carries the
 * same identifier — `HelloFrameSchema.client` in `websocket/frames.ts` — and
 * enforcing the floor there belongs to the handshake, not here. A client too
 * old to be served will already have been refused on the HTTP call that
 * registered its session, so the gap is a second line of defence rather than a
 * hole.
 *
 * @module
 */

import {
  CLIENT_VERSION_HEADER,
  ClientVersionHeaderSchema,
  ErrorCode,
  type GetVersionResponse,
  GetVersionResponseSchema,
  isClientTooOld,
  MIN_CLIENT_VERSION,
  PROTOCOL_VERSION,
  ProtocolError,
  upgradeRequiredMessage,
} from '@stackgrid/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The release this server build is.
 *
 * A constant for the same reason `packages/cli/src/version.ts` is one: `rootDir`
 * is `src`, so importing `../package.json` moves every emitted file down a
 * directory, and reading it with `fs` at runtime turns the one number an
 * operator asks for into a file the image might not contain. `./version.test.ts`
 * fails the build if this disagrees with `server/package.json`.
 *
 * One version number covers the whole repository (plan §12.1), so this is the
 * same string the CLI, the client and the protocol package publish.
 */
export const SERVER_VERSION = '0.2.0';

/**
 * The routes the client-version guard never refuses.
 *
 * Both are here for the same reason, and it is not "they are public". It is
 * that refusing them would destroy the information the refusal is trying to
 * convey:
 *
 * - **`/version`** — a client below the floor learns *what* floor it is below
 *   by asking this endpoint. Guarding it would answer "you are too old" to the
 *   one question whose answer says how to stop being too old, and `agentchat
 *   version --server …` is the command people are asked to run when nothing
 *   works.
 * - **`/healthz`** — an operator diagnosing a deployment, and the orchestrator
 *   deciding whether to route traffic, are not the party being asked to
 *   upgrade. An old `curl` in a smoke test must not be able to make a healthy
 *   server look unhealthy.
 *
 * Everything else is guarded. A route absent from this set is refused for a
 * too-old client, which is the direction that fails safe: a new public route
 * that should have been exempt produces a 426 naming the upgrade — a bug report
 * — while the opposite default would let the floor quietly stop applying to
 * whichever routes nobody remembered to list.
 */
export const VERSION_GUARD_EXEMPT_ROUTES: ReadonlySet<string> = new Set(['/version', '/healthz']);

/** Options for {@link registerVersionRoutes}. */
export interface VersionRouteOptions {
  /** The release to report. Defaults to {@link SERVER_VERSION}. */
  readonly version?: string;
  /** The protocol to report. Defaults to the protocol package's constant. */
  readonly protocolVersion?: number;
  /** The floor to report and enforce. Defaults to `MIN_CLIENT_VERSION`. */
  readonly minClientVersion?: string;
}

/**
 * Reads the client's announced version from a request.
 *
 * Three outcomes, and they are genuinely different:
 *
 * - **Absent** — `null`. Not an error. A third-party harness embedding
 *   `packages/client` is not the `agentchat` CLI and has no release version to
 *   claim, and `packages/protocol/src/schemas/version.ts` says such a caller is
 *   served. The floor exists to tell a *CLI user* to upgrade; it is not an
 *   admission gate for the API.
 * - **Malformed** — `BAD_REQUEST`. The header's grammar is part of the
 *   contract, and a caller that sends a version this server cannot compare must
 *   not be silently treated as if it had sent none: that would turn "I claim to
 *   be 0.0.1" into free passage past the floor.
 * - **Well-formed** — the bare version, product token stripped.
 *
 * @param request - The incoming request.
 * @returns The announced version, or `null` if the header was absent.
 * @throws {ProtocolError} `BAD_REQUEST` if the header is present but malformed.
 */
function announcedClientVersion(request: FastifyRequest): string | null {
  const raw = request.headers[CLIENT_VERSION_HEADER];
  if (raw === undefined) {
    return null;
  }

  // Node collapses a repeated header into an array. Two different version
  // claims in one request is not something to pick a winner from.
  const value = Array.isArray(raw) ? raw.join(', ') : raw;

  const parsed = ClientVersionHeaderSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `Invalid ${CLIENT_VERSION_HEADER} header. Expected a value of the form agentchat/X.Y.Z.`,
    );
  }

  return parsed.data;
}

/**
 * Registers `GET /version` and the client-version guard.
 *
 * The guard is an `onRequest` hook on the instance, so it covers every route on
 * it — including routes registered before this call, because Fastify assembles
 * the request hook chain at ready time rather than at registration. Register
 * this **before** `registerAuth` so a too-old client is told to upgrade rather
 * than told it is unauthenticated: both are true, and only one of them is
 * actionable.
 *
 * `/version` itself is declared public by the `onRoute` hook in `app.ts`, which
 * stamps `config.auth = 'public'` on the routes named in `PUBLIC_ROUTES`. That
 * list has named `/version` since before this route existed. Omitting the
 * declaration fails closed — the route would answer `AUTH_REQUIRED`, which is
 * precisely what it did while nothing matched this path — so this module says
 * nothing about authentication and the wiring site keeps saying all of it.
 *
 * @param app - Fastify instance to add the route and the hook to.
 * @param options - See {@link VersionRouteOptions}. Every field has a default;
 *   the production call passes none.
 */
export function registerVersionRoutes(app: FastifyInstance, options?: VersionRouteOptions): void {
  const version = options?.version ?? SERVER_VERSION;
  const protocolVersion = options?.protocolVersion ?? PROTOCOL_VERSION;
  const minClientVersion = options?.minClientVersion ?? MIN_CLIENT_VERSION;

  // Built once. The body is three constants and never varies by request, so
  // rebuilding it per call would only create somewhere for it to vary.
  //
  // Parsed rather than asserted, for the same reason every other route parses
  // its response: this is the one endpoint a client hits before it trusts
  // anything, and a server that reported a version its own schema rejects would
  // be unreadable by every client that validates.
  const body: GetVersionResponse = GetVersionResponseSchema.parse({
    version,
    protocolVersion,
    minClientVersion,
  });

  app.addHook('onRequest', (request: FastifyRequest, _reply: FastifyReply, done) => {
    if (VERSION_GUARD_EXEMPT_ROUTES.has(request.routeOptions.url ?? '')) {
      done();
      return;
    }

    let announced: string | null;
    try {
      announced = announcedClientVersion(request);
    } catch (error) {
      done(error as Error);
      return;
    }

    if (announced === null || !isClientTooOld(announced, minClientVersion)) {
      done();
      return;
    }

    // Logged because the operator of a server that starts refusing clients
    // wants to know it is happening and to whom, and the 426 itself only ever
    // reaches the person being refused.
    request.log.info(
      { clientVersion: announced, minClientVersion },
      'refusing a client below the minimum version',
    );

    // The message carries the floor and the command, because the client being
    // refused may predate every line of code that could have composed them —
    // that is what "too old" means. `upgradeRequiredMessage` is in
    // `@stackgrid/protocol` so this sentence and the one a current client
    // builds for itself cannot drift.
    done(new ProtocolError(ErrorCode.UPGRADE_REQUIRED, upgradeRequiredMessage(minClientVersion)));
  });

  // Plan §3 and §12.4. Unauthenticated, and it touches nothing that can fail.
  app.get('/version', async (): Promise<GetVersionResponse> => body);
}
