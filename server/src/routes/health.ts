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
 * Error code returned when the database round trip fails.
 *
 * Declared here rather than in `packages/protocol` because this endpoint is
 * operational, not part of the agent-facing protocol: it is read by load
 * balancers and operators, never by a harness branching on `--json` output.
 * The protocol package's frozen set is the contract for the latter, and
 * widening it for a code no client will ever see would blur what that
 * guarantee covers.
 *
 * See T-013, which decides whether that reasoning holds once the full HTTP
 * schema set exists. If it does not, this moves and the endpoint uses the
 * shared code instead.
 */
export const DATABASE_UNAVAILABLE = 'DATABASE_UNAVAILABLE';

/** Body returned when every check passes. */
export interface HealthyBody {
  readonly status: 'ok';
  readonly checks: { readonly database: 'ok' };
}

/** Body returned when a check fails. */
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
