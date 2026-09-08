/**
 * `GET /healthz` — liveness and readiness in one endpoint.
 *
 * The check performs a real query against PostgreSQL. A static 200 would tell
 * an operator that the process is running, which they can already see; what
 * they need to know is whether the process can still do its job. A server that
 * cannot reach its database answers 503 so a load balancer stops sending it
 * traffic while it recovers.
 *
 * Unauthenticated, per Plan §3.
 *
 * ## This route is operational, not protocol (T-013)
 *
 * Every other route in Plan §3 speaks the agent-facing protocol: its bodies are
 * zod schemas in `packages/protocol` and its failures are the frozen
 * `ErrorCode` envelope. This one does not, and the boundary is deliberate:
 * `/healthz` reports whether this process should receive traffic, to an
 * orchestrator deployed alongside it, and nothing it returns is a promise to a
 * client that upgrades on its own schedule.
 *
 * If you are writing a Plan §3 route, this file is not the pattern to copy.
 * Import the schemas and `ErrorCode` from `packages/protocol` — see the note on
 * {@link DATABASE_UNAVAILABLE} for why this route is the exception and what
 * would make it stop being one.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The part of the database handle this route needs.
 *
 * Narrowed to one method so the route cannot quietly grow a dependency on the
 * pool, and so a caller can supply any object that proves reachability.
 */
export interface HealthProbe {
  /**
   * Runs a trivial query against the database.
   *
   * @throws Whatever the driver throws when the database cannot be reached.
   */
  ping(): Promise<void>;
}

/**
 * How long the database round trip may take before the server calls itself
 * unhealthy, in milliseconds.
 *
 * Shorter than the pool's own connection timeout on purpose. A health probe
 * that hangs for as long as the driver is willing to wait holds a load
 * balancer's check open and delays the very failover it exists to trigger, and
 * a database that needs more than two seconds to answer `select 1` is not
 * healthy in any sense a caller cares about.
 */
export const HEALTH_CHECK_TIMEOUT_MS = 2_000;

/**
 * Error code reported when the database round trip fails.
 *
 * ## Decided: this stays out of the frozen set (T-013)
 *
 * T-007 declared it here and argued it was operational rather than
 * agent-facing. T-013 re-tested that argument against the full HTTP schema set,
 * which did not exist when it was written. Three pieces of evidence say it
 * holds:
 *
 * 1. **The plan never listed this route as protocol.** Plan §3's endpoint table
 *    — the set whose "bodies/responses are zod schemas in `packages/protocol`"
 *    — does not contain `/healthz`. It contains `GET /version`, which is also
 *    unauthenticated and also read by operators, and which duly has a schema.
 *    `/healthz` appears only in §3's auth exemption, §9's boot criterion, §11's
 *    deployment checklist and §12.6's upgrade job: four mentions, all
 *    operational. T-201 wrote a schema for every route in that table and none
 *    for this one, having had the choice.
 * 2. **This body is not the protocol envelope.** `ErrorEnvelopeSchema` is
 *    `{ error: { code, message } }` and nothing else. The failure body here is
 *    a status document — `status` and `checks` — that happens to carry an error
 *    object, so a code admitted to the frozen set would never actually travel
 *    in the contract's carrier. See {@link UnhealthyBody}.
 * 3. **It fails the set's own admission test.** `packages/protocol` admits a
 *    code only when a caller would take a *different action* on it. Nothing
 *    branches on this one: a load balancer acts on the 503, an operator reads
 *    `checks.database`, and the CI upgrade job asserts the status. The code is
 *    a label on a failure the caller has already fully diagnosed.
 *
 * The strongest case the other way is that adding a code is a minor, additive
 * change under §12.4, so joining is nearly free. It is — but that describes
 * admission, not membership. Removal or rename is a major bump with no
 * deprecation path, so the set is a one-way ratchet, and a member that fails
 * the admission test degrades what every other member means: the set stops
 * being "codes clients branch on" and becomes "codes we happened to emit". A
 * permanent cost to buy a cosmetic consistency is the wrong trade.
 *
 * ## What this code is, then
 *
 * A local label with no cross-version guarantee. Do not describe it as stable,
 * do not parse this body with `ErrorEnvelopeSchema`, and do not add it to
 * `packages/protocol`. It is also on the AGPL side of the licence boundary,
 * where a deployment concern belongs; `packages/` is MIT because third parties
 * embed it, and they do not embed a readiness probe.
 *
 * ## Where the next operational code goes
 *
 * There will be one, so the rule rather than the precedent:
 *
 * - **Never `packages/protocol`.** That set is the agent-facing contract.
 * - **The second one triggers consolidation.** While this is the only
 *   operational code, it lives with the route that emits it. When a second
 *   operational route needs one, both move to a single module under
 *   `server/src/` and neither is declared at a route again — that is the point
 *   at which "declared next to its route" would become the third authority
 *   this decision exists to prevent.
 * - **Apply the admission test in reverse.** If a client would ever branch on
 *   an operational code, it is not operational. It goes to `packages/protocol`
 *   through a plan change, not by being declared server-side and hoping.
 *
 * That last rule is also what would reopen this one: a documented caller that
 * branches on `DATABASE_UNAVAILABLE` rather than on the 503 moves it into the
 * frozen set as a minor, additive change.
 */
export const DATABASE_UNAVAILABLE = 'DATABASE_UNAVAILABLE';

/** Body returned when every check passes. */
export interface HealthyBody {
  readonly status: 'ok';
  readonly checks: { readonly database: 'ok' };
}

/**
 * Body returned when a check fails.
 *
 * Not the protocol error envelope, despite the resemblance. This is a status
 * document that reports every check and happens to explain the failing one;
 * `ErrorEnvelopeSchema` describes an object whose only member is `error`, and
 * parsing this with it would silently drop `status` and `checks` — the two
 * fields an operator actually reads. See {@link DATABASE_UNAVAILABLE}.
 */
export interface UnhealthyBody {
  readonly status: 'error';
  readonly checks: { readonly database: 'error' };
  readonly error: { readonly code: typeof DATABASE_UNAVAILABLE; readonly message: string };
}

/** Options for {@link registerHealthRoutes}. */
export interface HealthRouteOptions {
  /** Database handle the check queries. */
  readonly database: HealthProbe;
  /** Round-trip budget in milliseconds. Defaults to {@link HEALTH_CHECK_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
}

/** Raised when the database does not answer inside the health-check budget. */
class HealthCheckTimeoutError extends Error {
  public override readonly name = 'HealthCheckTimeoutError';

  public constructor(timeoutMs: number) {
    super(`The database did not respond within ${timeoutMs}ms.`);
  }
}

/**
 * Runs `probe.ping()` but gives up after `timeoutMs`.
 *
 * The losing promise is not abandoned: `pg` rejects it later if the connection
 * eventually fails, and an unobserved rejection would take the process down.
 */
async function pingWithin(probe: HealthProbe, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;

  const ping = probe.ping();
  // Observed here and re-thrown by the race below, so a rejection arriving
  // after the timeout has already won is never unhandled.
  ping.catch(() => undefined);

  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new HealthCheckTimeoutError(timeoutMs));
    }, timeoutMs);
    // Do not hold the event loop open for a health check that nobody is
    // waiting on any more.
    timer.unref();
  });

  try {
    await Promise.race([ping, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers `GET /healthz` on the given instance.
 *
 * @param app - Fastify instance to add the route to.
 * @param options - See {@link HealthRouteOptions}.
 */
export function registerHealthRoutes(app: FastifyInstance, options: HealthRouteOptions): void {
  const { database } = options;
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS;

  app.get(
    '/healthz',
    async (request: FastifyRequest, reply: FastifyReply): Promise<HealthyBody | UnhealthyBody> => {
      // A cached health check is worse than no health check: it reports the
      // state of the server that answered first, for as long as the cache
      // lives.
      reply.header('cache-control', 'no-store');

      try {
        await pingWithin(database, timeoutMs);
      } catch (error) {
        // The driver's message can name hosts, ports, roles and occasionally
        // the connection string, so it goes to the log and never to the
        // caller (Protocol §7.3).
        request.log.error({ err: error }, 'health check failed: database unreachable');

        reply.code(503);
        return {
          status: 'error',
          checks: { database: 'error' },
          error: {
            code: DATABASE_UNAVAILABLE,
            message: 'The database is not reachable.',
          },
        };
      }

      return { status: 'ok', checks: { database: 'ok' } };
    },
  );
}
