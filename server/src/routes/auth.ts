/**
 * `POST /auth/device/start` and `POST /auth/device/poll` — the login flow
 * (plan §3, §7, D4).
 *
 * ## The server brokers; it does not proxy
 *
 * The device code this route hands a client is **AgentChat's**, not the
 * identity provider's. The provider's device code stays here, in the pending
 * authorization record, and is replayed upstream on each poll.
 *
 * That is one line of code and three consequences:
 *
 * - Nothing provider-shaped reaches the wire, so D4's promise that "nothing in
 *   the protocol depends on GitHub" holds by construction rather than by
 *   review. Swapping providers cannot change what a client sees.
 * - The server can enforce its own polling interval, because it is the thing
 *   being polled. See {@link PollOutcome} and the note on `slow_down` below.
 * - A device code is single-use: the record is deleted the moment it is
 *   redeemed, so a replayed code is answered `DEVICE_CODE_EXPIRED` exactly as
 *   the contract says an already-redeemed one must be.
 *
 * ## Device codes are credentials
 *
 * Whoever holds one can complete a login. So: it is minted from 32 random
 * bytes, stored only as a SHA-256 digest — the same treatment plan §7 gives
 * refresh tokens — never written to a log, and never echoed in an error
 * message. The provider's device code is held in memory in plaintext because
 * polling requires replaying it, and it too is never logged.
 *
 * The store is in memory and lives for the ten-to-fifteen minutes an
 * authorization is valid. That is deliberate for v0.1 — the reference
 * deployment is one process on one VM (D6) — and it has one visible
 * consequence: a server restart makes in-flight logins expire early, and the
 * user runs `agentchat login` again. Running more than one server process
 * requires moving this into a table; see the pull request for T-103.
 *
 * ## Wiring
 *
 * `registerAuthRoutes` takes its collaborators as arguments, like every other
 * route module here. It is not yet called from `app.ts`, which T-103 does not
 * own; see the pull request for the three lines that connect it.
 *
 * @module
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  ErrorCode,
  PollDeviceAuthorizationRequestSchema,
  type PollDeviceAuthorizationResponse,
  PollDeviceAuthorizationResponseSchema,
  ProtocolError,
  StartDeviceAuthorizationRequestSchema,
  type StartDeviceAuthorizationResponse,
  StartDeviceAuthorizationResponseSchema,
  type User,
  UserId,
  UserSchema,
} from '@agentchat/protocol';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { IdentityProvider, ProviderIdentity } from '../auth/github.js';
import { SLOW_DOWN_INCREMENT_SECONDS } from '../auth/github.js';
import { users } from '../db/schema/identity.js';

/** Bytes of entropy in an AgentChat device code. Matches plan §7's refresh tokens. */
const DEVICE_CODE_BYTES = 32;

/**
 * Slack allowed on the advertised interval, in milliseconds.
 *
 * A client that sleeps for exactly `interval` seconds arrives a hair early
 * whenever the two clocks disagree or an event loop tick runs long. Answering
 * that with "you are polling too fast" would punish the well-behaved client and
 * teach the badly-behaved one nothing.
 */
const POLL_TOLERANCE_MS = 500;

/**
 * Most in-flight authorizations held at once.
 *
 * `POST /auth/device/start` is unauthenticated, so the store is reachable by
 * anyone who can reach the server. Expired records are swept on every call, and
 * this bound is what stops a caller minting faster than they expire. Roughly a
 * megabyte at the limit.
 */
const MAX_PENDING_AUTHORIZATIONS = 10_000;

/** Header carrying how long a caller should wait before retrying. */
export const RETRY_AFTER_HEADER = 'retry-after';

/** Postgres `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/** Milliseconds in a second, named so the arithmetic below reads as intent. */
const MS_PER_SECOND = 1000;

/**
 * The credentials a successful login issues.
 *
 * Structurally the token half of {@link PollDeviceAuthorizationResponse}.
 */
export interface IssuedCredentials {
  /** Short-lived bearer credential. */
  readonly accessToken: string;
  /** Long-lived credential, rotated on every use. */
  readonly refreshToken: string;
}

/**
 * The part of the token service this route needs: mint a pair for a user.
 *
 * **Deliberately one method.** T-104 owns `server/src/auth/tokens.ts` and is
 * being written in parallel with this, so depending on the interface rather
 * than on the module is what lets both land without either waiting. It is also
 * the smaller dependency on its own merits: this route knows when a login
 * succeeded and knows nothing about JWT claims, rotation, reuse detection or
 * revocation, and it should not acquire an opinion about them by importing a
 * larger surface than it uses.
 *
 * Wiring the two together is `tokens: createTokenService(...)` in `index.ts`
 * once T-104 lands — provided its service satisfies this shape. See the pull
 * request for T-103, which states the expectation explicitly.
 */
export interface TokenIssuer {
  /**
   * Issues an access/refresh pair for a user who has just authenticated.
   *
   * @param userId - The user the credentials authenticate.
   * @returns The pair, exactly as it is returned to the client.
   * @throws {ProtocolError} If the pair could not be issued.
   */
  issueForUser(userId: UserId): Promise<IssuedCredentials>;
}

/**
 * The part of the user store this route needs: turn a provider identity into a
 * local account.
 *
 * An interface rather than a function on the database handle so that the login
 * flow can be tested without Postgres, and so the upsert has one implementation
 * that every future caller shares. {@link createUserDirectory} is that
 * implementation; it belongs in a service module of its own once one exists,
 * which T-103 does not own.
 */
export interface UserDirectory {
  /**
   * Creates or updates the account for a provider identity.
   *
   * Matching is by {@link ProviderIdentity.subject}, never by username: a
   * username can be renamed and reused by somebody else, and matching on it
   * would hand the second person the first person's account.
   *
   * @param identity - The person, as the provider described them.
   * @returns The stored account, in protocol shape.
   * @throws {ProtocolError} `CONFLICT` if the username belongs to a different
   *   account, `INTERNAL` if the row could not be written.
   */
  upsertFromIdentity(identity: ProviderIdentity): Promise<User>;
}

/**
 * The parts of the Drizzle handle {@link createUserDirectory} uses.
 *
 * Narrowed the way `HealthProbe` narrows the health check's dependency: the
 * directory cannot quietly grow a use for the pool, and a caller may pass a
 * handle typed with any schema.
 */
export type UserDirectoryDatabase = Pick<NodePgDatabase<Record<string, never>>, 'insert'>;

/** What one poll of a device authorization resolved to. */
export type PollOutcome =
  /** Approved. The body is ready to send. */
  | { readonly kind: 'approved'; readonly body: PollDeviceAuthorizationResponse }
  /** Still waiting on the user; retry in `retryAfterSeconds`. */
  | { readonly kind: 'pending'; readonly retryAfterSeconds: number }
  /** Polling too fast — the client's own fault or the provider's complaint. */
  | { readonly kind: 'slow_down'; readonly retryAfterSeconds: number }
  /** The user refused in the browser. */
  | { readonly kind: 'denied' }
  /** Unknown, expired, or already-redeemed device code. */
  | { readonly kind: 'expired' };

/** Options for {@link registerAuthRoutes} and {@link createDeviceAuthorizationService}. */
export interface AuthRouteOptions {
  /** Brokers the device flow. See `../auth/github.ts` for the seam. */
  readonly identityProvider: IdentityProvider;
  /** Mints the credentials a successful login returns. */
  readonly tokens: TokenIssuer;
  /** Turns a provider identity into a local account. */
  readonly users: UserDirectory;
  /** Clock, in milliseconds since the epoch. Injectable so tests need no timers. */
  readonly now?: () => number;
}

/** A device authorization the server is brokering. */
interface PendingAuthorization {
  /** The provider's device code. Never logged, never returned. */
  readonly providerDeviceCode: string;
  /** When the authorization stops being redeemable. */
  readonly expiresAtMs: number;
  /** Current polling interval in seconds; grows when the provider says so. */
  intervalSeconds: number;
  /** Earliest instant the next poll may reach the provider. */
  nextPollAtMs: number;
}

/**
 * Digests a device code.
 *
 * The store is keyed by the digest so that a heap dump, a debugger session or
 * an accidental serialisation of the map exposes no redeemable credential —
 * the same reasoning that keeps refresh tokens hashed in the database (plan
 * §7).
 */
function digestOf(deviceCode: string): string {
  return createHash('sha256').update(deviceCode, 'utf8').digest('hex');
}

/**
 * Parses a request body against a protocol schema.
 *
 * @param schema - The schema from `packages/protocol` for this endpoint.
 * @param body - Whatever Fastify parsed, which may be `undefined`.
 * @returns The validated body.
 * @throws {ProtocolError} `BAD_REQUEST` naming the offending fields. The
 *   *values* are never echoed: one of them is a credential.
 */
function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (result.success) {
    return result.data;
  }

  const problems = result.error.issues.map((issue) => {
    const field = issue.path.join('.');
    return field === '' ? issue.message : `${field}: ${issue.message}`;
  });

  throw new ProtocolError(ErrorCode.BAD_REQUEST, `Invalid request body. ${problems.join('; ')}`);
}

/**
 * Whether a thrown value is a Postgres unique violation on the given
 * constraint.
 *
 * Walks the cause chain because Drizzle wraps driver errors, and matches the
 * constraint name so that a collision on the username is distinguished from one
 * on the provider subject.
 */
function isUniqueViolationOn(error: unknown, constraintFragment: string): boolean {
  let current: unknown = error;

  while (typeof current === 'object' && current !== null) {
    if ('code' in current) {
      const { code, constraint } = current as { code: unknown; constraint?: unknown };
      if (code === UNIQUE_VIOLATION) {
        return typeof constraint === 'string' && constraint.includes(constraintFragment);
      }
    }
    current = 'cause' in current ? (current as { cause: unknown }).cause : undefined;
  }

  return false;
}

/**
 * The Postgres-backed {@link UserDirectory}.
 *
 * The upsert is one statement — `insert … on conflict (github_id) do update` —
 * so two logins racing on a new account cannot both insert, and neither has to
 * retry. The generated id is discarded by the database on the update path,
 * which costs one wasted UUID and buys a single round trip.
 *
 * `github_id` is the column plan §2 gives the provider's subject; the name is
 * the schema's (T-101), not an assumption by this module, which never learns
 * which provider produced the identity.
 *
 * @param db - A Drizzle handle. Only `insert` is used.
 * @returns A directory ready to upsert identities.
 */
export function createUserDirectory(db: UserDirectoryDatabase): UserDirectory {
  return {
    async upsertFromIdentity(identity: ProviderIdentity): Promise<User> {
      // Lowercased at the provider boundary already; done again here because
      // this is the last point before a `users_username_format` violation, and
      // a second `toLowerCase()` is cheaper than a 500.
      const username = identity.username.toLowerCase();

      const values = {
        id: UserId.generate(),
        githubId: identity.subject,
        username,
        displayName: identity.displayName,
        email: identity.email,
      };

      let rows: (typeof users.$inferSelect)[];
      try {
        rows = await db
          .insert(users)
          .values(values)
          .onConflictDoUpdate({
            target: users.githubId,
            set: {
              username,
              displayName: identity.displayName,
              email: identity.email,
            },
          })
          .returning();
      } catch (cause: unknown) {
        if (isUniqueViolationOn(cause, 'username')) {
          // The provider let somebody else take a username this server has
          // already seen. Not recoverable here, and not a 500: the operator
          // has to decide what happens to the older account.
          throw new ProtocolError(
            ErrorCode.CONFLICT,
            'That username already belongs to a different account on this server.',
            { cause },
          );
        }
        throw new ProtocolError(ErrorCode.INTERNAL, 'The account could not be stored.', { cause });
      }

      const row = rows[0];
      if (row === undefined) {
        throw new ProtocolError(ErrorCode.INTERNAL, 'The account upsert returned no row.');
      }

      // Parsed on the way out, like every other value this server puts on the
      // wire: a column that drifts from the contract is a server bug, and this
      // is where it is caught rather than at a client.
      return UserSchema.parse({
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        email: row.email,
        createdAt: row.createdAt.toISOString(),
      });
    },
  };
}

/** The login flow, with no HTTP in it. */
export interface DeviceAuthorizationService {
  /**
   * Starts an authorization and records it.
   *
   * @returns The response body for `POST /auth/device/start`.
   * @throws {ProtocolError} `INTERNAL` if the provider failed or the server is
   *   already holding as many authorizations as it will.
   */
  start(): Promise<StartDeviceAuthorizationResponse>;

  /**
   * Polls one authorization.
   *
   * @param deviceCode - The device code this server issued.
   * @returns What the poll resolved to; see {@link PollOutcome}.
   * @throws {ProtocolError} `INTERNAL` if the provider failed, `CONFLICT` if
   *   the username collides with an existing account.
   */
  poll(deviceCode: string): Promise<PollOutcome>;

  /** How many authorizations are in flight. For tests and diagnostics. */
  size(): number;
}

/**
 * Builds the login flow.
 *
 * Separated from the route so that the rules — single use, expiry, rate
 * limiting, upsert-then-issue ordering — are testable without a socket and
 * cannot be bypassed by a second caller that reimplements the handler
 * (Protocol §7.3: no business logic in route handlers).
 *
 * @param options - See {@link AuthRouteOptions}.
 * @returns A service holding its own in-memory store of pending authorizations.
 */
export function createDeviceAuthorizationService(
  options: AuthRouteOptions,
): DeviceAuthorizationService {
  const { identityProvider, tokens, users: directory } = options;
  const now = options.now ?? Date.now;

  /** Pending authorizations, keyed by the SHA-256 of the device code issued. */
  const pending = new Map<string, PendingAuthorization>();

  /** Drops every authorization that can no longer be redeemed. */
  function sweep(at: number): void {
    for (const [key, record] of pending) {
      if (at >= record.expiresAtMs) {
        pending.delete(key);
      }
    }
  }

  /**
   * Finds the record a device code names.
   *
   * The lookup is by digest, which is both what makes the stored key
   * non-redeemable and why no comparison here runs over the credential itself:
   * a hash table keyed on a SHA-256 gives an attacker nothing to time.
   */
  function lookup(deviceCode: string): { key: string; record: PendingAuthorization } | undefined {
    const key = digestOf(deviceCode);
    const record = pending.get(key);
    return record === undefined ? undefined : { key, record };
  }

  /** Seconds a caller should wait, rounded up and never below one. */
  function secondsUntil(instantMs: number, at: number): number {
    return Math.max(1, Math.ceil((instantMs - at) / MS_PER_SECOND));
  }

  return {
    async start(): Promise<StartDeviceAuthorizationResponse> {
      const at = now();
      sweep(at);

      if (pending.size >= MAX_PENDING_AUTHORIZATIONS) {
        throw new ProtocolError(
          ErrorCode.INTERNAL,
          'Too many device authorizations are already in flight.',
        );
      }

      const grant = await identityProvider.startDeviceAuthorization();

      // Read again after the round trip. `expiresIn` is measured from the
      // moment the response was produced, and dating it from before the call
      // would have this server keep a code alive for slightly longer than the
      // provider will honour it.
      const issuedAt = now();

      // The client's device code is minted here and has nothing to do with the
      // provider's. See the module note.
      const deviceCode = randomBytes(DEVICE_CODE_BYTES).toString('base64url');

      pending.set(digestOf(deviceCode), {
        providerDeviceCode: grant.deviceCode,
        expiresAtMs: issuedAt + grant.expiresIn * MS_PER_SECOND,
        intervalSeconds: grant.interval,
        // The advertised interval applies from the start: the first poll is
        // due one interval from now, not immediately. A client that ignores
        // this is answered by the rate limiter rather than by the provider's.
        nextPollAtMs: issuedAt + grant.interval * MS_PER_SECOND,
      });

      // Parsed outbound, so a provider that returns something the contract
      // cannot express fails here rather than at the client.
      return StartDeviceAuthorizationResponseSchema.parse({
        deviceCode,
        userCode: grant.userCode,
        verificationUri: grant.verificationUri,
        interval: grant.interval,
        expiresIn: grant.expiresIn,
      });
    },

    async poll(deviceCode: string): Promise<PollOutcome> {
      const at = now();
      sweep(at);

      const found = lookup(deviceCode);
      if (found === undefined) {
        // Unknown, expired and already-redeemed are one answer on purpose. The
        // contract gives them one code, and distinguishing them would tell a
        // guesser which of their guesses had ever been a real code.
        return { kind: 'expired' };
      }

      const { key, record } = found;

      if (at + POLL_TOLERANCE_MS < record.nextPollAtMs) {
        // The client is polling faster than it was told to. The provider is not
        // asked at all: absorbing this here is what keeps one impatient client
        // from spending the whole server's rate limit with the provider.
        return { kind: 'slow_down', retryAfterSeconds: secondsUntil(record.nextPollAtMs, at) };
      }

      const outcome = await identityProvider.redeemDeviceAuthorization(record.providerDeviceCode);

      switch (outcome.status) {
        case 'pending': {
          record.nextPollAtMs = at + record.intervalSeconds * MS_PER_SECOND;
          return { kind: 'pending', retryAfterSeconds: record.intervalSeconds };
        }

        case 'slow_down': {
          // RFC 8628 §3.5: on `slow_down` the interval grows and stays grown.
          // Taking the larger of the provider's number and our own increment
          // means a provider that sends a smaller interval cannot undo a
          // back-off it just asked for.
          record.intervalSeconds = Math.max(
            outcome.interval,
            record.intervalSeconds + SLOW_DOWN_INCREMENT_SECONDS,
          );
          record.nextPollAtMs = at + record.intervalSeconds * MS_PER_SECOND;
          return { kind: 'slow_down', retryAfterSeconds: record.intervalSeconds };
        }

        case 'denied': {
          pending.delete(key);
          return { kind: 'denied' };
        }

        case 'expired': {
          pending.delete(key);
          return { kind: 'expired' };
        }

        case 'approved': {
          // Deleted before the account is written, not after. Everything below
          // this line can fail, and a device code that survives its own
          // redemption is a credential that mints token pairs on demand.
          pending.delete(key);

          const user = await directory.upsertFromIdentity(outcome.identity);
          const credentials = await tokens.issueForUser(UserId.parse(user.id));

          return {
            kind: 'approved',
            body: PollDeviceAuthorizationResponseSchema.parse({
              accessToken: credentials.accessToken,
              refreshToken: credentials.refreshToken,
              user,
            }),
          };
        }

        default: {
          // Unreachable while `DeviceAuthorizationOutcome` is exhaustive above;
          // present so that adding a state to it fails here loudly rather than
          // falling through to a success.
          throw new ProtocolError(
            ErrorCode.INTERNAL,
            'The identity provider reported an outcome this server does not understand.',
          );
        }
      }
    },

    size(): number {
      return pending.size;
    },
  };
}

/**
 * Turns a {@link PollOutcome} into the response, or into the error that
 * describes it.
 *
 * Every non-approved outcome is an error envelope, because that is how the
 * protocol carries them (see the module note in
 * `packages/protocol/src/schemas/auth.ts`): only the approved case has a body.
 *
 * Three of the four map onto a code whose meaning is exactly this situation.
 * The fourth, `slow_down`, does not: the frozen set has no rate-limit code, and
 * T-103 may not add one. `CONFLICT` is used because it is the only code left
 * that a caller can distinguish from "keep polling" and from "stop", which is
 * what a client must do differently here — and the actionable part, how long to
 * wait, is carried where HTTP already carries it, in `Retry-After`, on this
 * response and on the 428. A `RATE_LIMITED` code would be a better answer and
 * is an additive change under plan §12.4; see the pull request for T-103.
 */
function sendPollOutcome(outcome: PollOutcome, reply: FastifyReply): PollDeviceAuthorizationResponse {
  switch (outcome.kind) {
    case 'approved':
      return outcome.body;

    case 'pending':
      reply.header(RETRY_AFTER_HEADER, String(outcome.retryAfterSeconds));
      throw new ProtocolError(
        ErrorCode.AUTH_PENDING,
        'Waiting for the user to approve this login in the browser.',
      );

    case 'slow_down':
      reply.header(RETRY_AFTER_HEADER, String(outcome.retryAfterSeconds));
      throw new ProtocolError(
        ErrorCode.CONFLICT,
        `Polling too fast. Wait ${outcome.retryAfterSeconds} seconds before polling again.`,
      );

    case 'denied':
      throw new ProtocolError(
        ErrorCode.FORBIDDEN,
        'The login was denied. Start again if this was a mistake.',
      );

    case 'expired':
      throw new ProtocolError(
        ErrorCode.DEVICE_CODE_EXPIRED,
        'This device code has expired or has already been used. Start the login again.',
      );

    default:
      throw new ProtocolError(ErrorCode.INTERNAL, 'Unhandled device authorization outcome.');
  }
}

/**
 * Registers the device-flow routes.
 *
 * Both are unauthenticated, per plan §3: they are how a caller acquires the
 * credentials every other route requires.
 *
 * @param app - Fastify instance to add the routes to.
 * @param options - Collaborators; see {@link AuthRouteOptions}.
 */
export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const service = createDeviceAuthorizationService(options);

  app.post(
    '/auth/device/start',
    async (request: FastifyRequest, reply: FastifyReply): Promise<StartDeviceAuthorizationResponse> => {
      // The body carries a device code the client must store. A cache anywhere
      // between here and it would be holding a credential.
      reply.header('cache-control', 'no-store');

      parseBody(StartDeviceAuthorizationRequestSchema, request.body);
      return await service.start();
    },
  );

  app.post(
    '/auth/device/poll',
    async (request: FastifyRequest, reply: FastifyReply): Promise<PollDeviceAuthorizationResponse> => {
      reply.header('cache-control', 'no-store');

      const body = parseBody(PollDeviceAuthorizationRequestSchema, request.body);
      return sendPollOutcome(await service.poll(body.deviceCode), reply);
    },
  );
}
