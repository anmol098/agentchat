/**
 * Authentication routes (plan §3, §7, D4), in two groups with two register
 * functions.
 *
 * {@link registerAuthRoutes} is the login flow — `POST /auth/device/start` and
 * `POST /auth/device/poll` — which is how a caller with no credentials acquires
 * some. {@link registerIdentityRoutes} is what a caller does with the
 * credentials afterwards — `GET /me`, `POST /auth/refresh` and
 * `POST /auth/logout`.
 *
 * Two functions rather than one because the two halves need different
 * collaborators: the login flow brokers an identity provider and mints
 * credentials, and nothing in the second half has any use for either. Keeping
 * them apart is what lets `routes/auth.test.ts` drive the device flow with two
 * stubs instead of four, and stops a route that answers "who am I" holding a
 * handle that can create accounts.
 *
 * The rest of this note is about the login flow. See
 * {@link registerIdentityRoutes} for the other three, including why exactly one
 * of them answers without an access token and why this module cannot be the
 * thing that decides that.
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
 * ## Expiry costs nothing to check
 *
 * A hash table alone cannot answer "has anything expired?" without looking at
 * everything, and this store used to do exactly that on both routes, which are
 * both unauthenticated (T-031). It is now a hash table plus a min-heap on
 * expiry: the head is always the next thing to die, so the question is one
 * comparison, and the answer never depends on when anything last ran — a
 * device code is checked against its own expiry instant when it is looked up.
 *
 * That shape is the same one a table would have — a row per authorization and
 * an index on the expiry column, where `DELETE ... WHERE expires_at <= now()`
 * and `SELECT ... WHERE key = $1 AND expires_at > now()` are the two queries
 * below spelled in SQL. Moving the store into Postgres, which is what running
 * more than one process needs, got no harder for having done this.
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
  type GetCurrentUserResponse,
  LogoutRequestSchema,
  type LogoutResponse,
  PollDeviceAuthorizationRequestSchema,
  type PollDeviceAuthorizationResponse,
  PollDeviceAuthorizationResponseSchema,
  ProtocolError,
  RefreshTokensRequestSchema,
  type RefreshTokensResponse,
  StartDeviceAuthorizationRequestSchema,
  type StartDeviceAuthorizationResponse,
  StartDeviceAuthorizationResponseSchema,
  type User,
  UserId,
  UserSchema,
} from '@agentchat/protocol';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { IdentityProvider, ProviderIdentity } from '../auth/identity.js';
import { SLOW_DOWN_INCREMENT_SECONDS } from '../auth/identity.js';
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
 * anyone who can reach the server. Expired records are reclaimed as they
 * expire, and this bound is what stops a caller minting faster than they
 * expire. Roughly a megabyte at the limit.
 */
export const MAX_PENDING_AUTHORIZATIONS = 10_000;

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
 * The part of the token service the credential-lifecycle routes need: spend a
 * refresh token, or throw it away.
 *
 * Narrow for the same reason {@link TokenIssuer} is narrow, and narrow in a
 * direction that matters here. **Neither method has a policy of its own.**
 * Rotation, reuse detection and the revocation that answers a replay all live
 * in `auth/tokens.ts` (T-104), where they are already tested against a real
 * database. `POST /auth/refresh` is a wire adapter over {@link refresh}: it
 * parses a body, calls it, and returns what comes back. In particular it does
 * not catch `RefreshTokenReuseError` and translate it, because that error is
 * thrown *after* the chain revocation has committed, and a route that
 * "helpfully" turned it into a retry would be advertising a credential the
 * server has already destroyed.
 */
export interface TokenRotator {
  /**
   * Spends a refresh token and returns its replacement.
   *
   * @param refreshToken - The token the client is presenting.
   * @returns A new pair. The refresh token is always different from the one
   *   sent; plan §7 rotates on every use.
   * @throws {ProtocolError} `AUTH_REQUIRED` if the token is unknown, expired,
   *   or already spent. A replay additionally revokes every live token for that
   *   account before throwing.
   */
  refresh(refreshToken: string): Promise<IssuedCredentials>;

  /**
   * Revokes a refresh token, if it is still live.
   *
   * Idempotent, and that is a contract rather than an implementation detail:
   * `LogoutResponseSchema` promises that logging out twice is a success, and a
   * client that retries a logout after a dropped connection depends on it.
   * Revoking an already-revoked token must **not** be read as reuse — logging
   * out twice is a careful client, not a stolen credential, and answering it by
   * revoking the account's other sessions would be a self-inflicted denial of
   * service.
   *
   * @param refreshToken - The token to revoke. Unknown strings are accepted.
   */
  revoke(refreshToken: string): Promise<void>;
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
 * Reading an account back that a login has already created.
 *
 * Separate from {@link UserDirectory} because the two have different callers
 * and different reasons to exist: the device flow writes, and `GET /me` reads.
 * A route that only answers "who am I" has no business holding a handle that
 * can upsert an account, and the login flow has no business holding one that
 * can look up an arbitrary user id.
 */
export interface UserLookup {
  /**
   * The account behind a user id, or `undefined` when there is none.
   *
   * `undefined` rather than a throw: whether a missing row is a 401, a 404 or a
   * 500 depends on why the caller was asking, and only the caller knows.
   *
   * @param userId - The account to read.
   * @returns The stored account in protocol shape, or `undefined`.
   */
  findById(userId: UserId): Promise<User | undefined>;
}

/**
 * The parts of the Drizzle handle {@link createUserDirectory} uses.
 *
 * Narrowed the way `HealthProbe` narrows the health check's dependency: the
 * directory cannot quietly grow a use for the pool, and a caller may pass a
 * handle typed with any schema.
 */
export type UserDirectoryDatabase = Pick<
  NodePgDatabase<Record<string, never>>,
  'insert' | 'select'
>;

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
  /** Brokers the device flow. See `../auth/identity.ts` for the seam. */
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
 * One entry in the expiry queue: a key in the store and when it stops being
 * redeemable.
 *
 * A copy of the expiry rather than a reference to the record, so that a node
 * left behind by a redeemed authorization can be recognised as stale without
 * the record it named still existing.
 */
interface ExpiryNode {
  /** The key in the pending store — the digest of a device code. */
  readonly key: string;
  /** The `expiresAtMs` the record had when the node was queued. */
  readonly expiresAtMs: number;
}

/**
 * Restores the heap property by moving `heap[from]` towards the root.
 *
 * Written as a hole-punching loop rather than a sequence of swaps: the moving
 * node is read once and written once, and the elements it passes shift down by
 * one. Half the array writes of the swap form, for the same result.
 */
function siftUp(heap: ExpiryNode[], from: number): void {
  const node = heap[from];
  if (node === undefined) {
    return;
  }

  let index = from;
  while (index > 0) {
    const parentIndex = (index - 1) >> 1;
    const parent = heap[parentIndex];
    if (parent === undefined || parent.expiresAtMs <= node.expiresAtMs) {
      break;
    }
    heap[index] = parent;
    index = parentIndex;
  }

  heap[index] = node;
}

/** Restores the heap property by moving `heap[from]` towards the leaves. */
function siftDown(heap: ExpiryNode[], from: number): void {
  const node = heap[from];
  if (node === undefined) {
    return;
  }

  // Nodes at or past the halfway point have no children, so the loop stops
  // there rather than testing for missing children on every pass.
  const firstLeaf = heap.length >> 1;
  let index = from;

  while (index < firstLeaf) {
    let childIndex = index * 2 + 1;
    let child = heap[childIndex];

    const rightIndex = childIndex + 1;
    const right = heap[rightIndex];
    if (right !== undefined && child !== undefined && right.expiresAtMs < child.expiresAtMs) {
      childIndex = rightIndex;
      child = right;
    }

    if (child === undefined || child.expiresAtMs >= node.expiresAtMs) {
      break;
    }

    heap[index] = child;
    index = childIndex;
  }

  heap[index] = node;
}

/** Adds a node. O(log n). */
function heapPush(heap: ExpiryNode[], node: ExpiryNode): void {
  heap.push(node);
  siftUp(heap, heap.length - 1);
}

/** Removes and returns the earliest-expiring node. O(log n). */
function heapPop(heap: ExpiryNode[]): ExpiryNode | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (last !== undefined && heap.length > 0) {
    heap[0] = last;
    siftDown(heap, 0);
  }
  return top;
}

/** Turns an arbitrary array into a heap in place. O(n) — Floyd's method. */
function heapify(heap: ExpiryNode[]): void {
  for (let index = (heap.length >> 1) - 1; index >= 0; index -= 1) {
    siftDown(heap, index);
  }
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
 * The one place a `users` row becomes the protocol's `User`.
 *
 * There is exactly one mapping because there is exactly one `User` on the wire.
 * `POST /auth/device/poll` and `GET /me` both answer with an account, and
 * before this function existed the first one built that object inline — so the
 * second was one copy-paste away from being a second, subtly different shape,
 * differing in a timestamp format or a field nobody remembered to include. A
 * client parsing `UserSchema` would have caught it; a client reading a field
 * would not.
 *
 * Parsed on the way out, like every other value this server puts on the wire: a
 * column that drifts from the contract is a server bug, and this is where it is
 * caught rather than at a client.
 *
 * @param row - The stored account.
 * @returns The account in protocol shape.
 * @throws {Error} If the row does not satisfy `UserSchema`.
 */
function toProtocolUser(row: typeof users.$inferSelect): User {
  return UserSchema.parse({
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    createdAt: row.createdAt.toISOString(),
  });
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
 * The same object also satisfies {@link UserLookup}, so that the write path and
 * the read path share {@link toProtocolUser} rather than each deciding for
 * itself what a `User` looks like. The two interfaces stay separate because
 * their callers are separate; only the wiring site sees both halves.
 *
 * @param db - A Drizzle handle. Only `insert` and `select` are used.
 * @returns A directory ready to upsert identities and to read them back.
 */
export function createUserDirectory(db: UserDirectoryDatabase): UserDirectory & UserLookup {
  return {
    async findById(userId: UserId): Promise<User | undefined> {
      const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      const row = rows[0];
      return row === undefined ? undefined : toProtocolUser(row);
    },

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

      return toProtocolUser(row);
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

  /**
   * The same keys again, ordered by expiry: a binary min-heap on `expiresAtMs`.
   *
   * This exists because the previous store dropped expired records by walking
   * the whole map, on `start` and on `poll`, both of which are unauthenticated.
   * At the bound that is ten thousand iterations per request, and it is `start`
   * that fills the map, so an anonymous caller could buy everybody a fixed tax
   * on every request afterwards (T-031).
   *
   * An ordered structure rather than a timer, for three reasons. It needs no
   * owner: a timer's lifetime has to be tied to the application that started it
   * — this project already learned that from the session sweeper, which
   * `app.ts` stops on close — and `app.ts` is not this task's to change. It has
   * no schedule, so a slot is freed the instant its authorization expires
   * rather than at the next tick, which is what keeps the bound a bound. And a
   * heap is exact where a timer is approximate: the head is always the next
   * thing to expire, so asking "is anything expired?" is one comparison, and
   * reclaiming k records costs O(k log n) whoever asks.
   *
   * Nodes are not removed when an authorization is redeemed, only when they
   * reach the head; {@link forget} counts what that leaves behind and compacts.
   */
  let expiryQueue: ExpiryNode[] = [];

  /**
   * Nodes in {@link expiryQueue} whose record is gone.
   *
   * Exact, not an estimate: a key is the digest of 32 fresh random bytes, so no
   * key is ever queued twice, and every record that leaves the map without its
   * node being popped is counted here exactly once.
   */
  let staleNodes = 0;

  /** Drops the stale nodes and rebuilds the heap. O(n). */
  function compactExpiryQueue(): void {
    expiryQueue = expiryQueue.filter(
      (node) => pending.get(node.key)?.expiresAtMs === node.expiresAtMs,
    );
    heapify(expiryQueue);
    staleNodes = 0;
  }

  /**
   * Removes a record that is not being expired — redeemed, denied, or found
   * expired by {@link lookup}.
   *
   * Its queue node is left in place, because taking an arbitrary node out of a
   * binary heap needs an index this store does not keep. Compacting once the
   * stale nodes outnumber the live ones costs O(n) but buys at least n/2
   * removals, so removal stays O(1) amortised, and the queue cannot hold more
   * than twice the bound.
   */
  function forget(key: string): void {
    if (!pending.delete(key)) {
      return;
    }

    staleNodes += 1;
    if (staleNodes * 2 > expiryQueue.length) {
      compactExpiryQueue();
    }
  }

  /**
   * Reclaims the slots of every authorization that has expired.
   *
   * Memory hygiene and what keeps {@link MAX_PENDING_AUTHORIZATIONS} a bound
   * rather than a wall. It is deliberately *not* what makes an expired
   * authorization unredeemable — see {@link lookup} — so no answer this service
   * gives depends on when it last ran.
   *
   * Costs one comparison when nothing has expired, whatever the store holds.
   */
  function expire(at: number): void {
    for (;;) {
      const head = expiryQueue[0];
      if (head === undefined || at < head.expiresAtMs) {
        return;
      }

      heapPop(expiryQueue);
      if (pending.get(head.key)?.expiresAtMs === head.expiresAtMs) {
        pending.delete(head.key);
      } else {
        staleNodes -= 1;
      }
    }
  }

  /**
   * Finds the record a device code names, if it is still redeemable.
   *
   * The lookup is by digest, which is both what makes the stored key
   * non-redeemable and why no comparison here runs over the credential itself:
   * a hash table keyed on a SHA-256 gives an attacker nothing to time.
   *
   * Expiry is decided here, against the record's own `expiresAtMs`, and not by
   * whether anything has swept it away yet. A device code is dead the
   * millisecond it expires even if it is still sitting in the map.
   */
  function lookup(
    deviceCode: string,
    at: number,
  ): { key: string; record: PendingAuthorization } | undefined {
    const key = digestOf(deviceCode);
    const record = pending.get(key);
    if (record === undefined) {
      return undefined;
    }

    if (at >= record.expiresAtMs) {
      forget(key);
      return undefined;
    }

    return { key, record };
  }

  /** Seconds a caller should wait, rounded up and never below one. */
  function secondsUntil(instantMs: number, at: number): number {
    return Math.max(1, Math.ceil((instantMs - at) / MS_PER_SECOND));
  }

  return {
    async start(): Promise<StartDeviceAuthorizationResponse> {
      const at = now();

      // Before the bound is tested, so that a store full of expired records
      // admits the next caller rather than refusing until an operator
      // intervenes. Costs one comparison unless something has actually expired.
      expire(at);

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

      const key = digestOf(deviceCode);
      const expiresAtMs = issuedAt + grant.expiresIn * MS_PER_SECOND;

      pending.set(key, {
        providerDeviceCode: grant.deviceCode,
        expiresAtMs,
        intervalSeconds: grant.interval,
        // The advertised interval applies from the start: the first poll is
        // due one interval from now, not immediately. A client that ignores
        // this is answered by the rate limiter rather than by the provider's.
        nextPollAtMs: issuedAt + grant.interval * MS_PER_SECOND,
      });
      heapPush(expiryQueue, { key, expiresAtMs });

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

      // Resolved before anything is reclaimed, and on the record's own expiry.
      // The order is the point: the answer below is already decided by the time
      // `expire` runs, so it cannot be an artefact of the store having been
      // tidied first, on this call or on any earlier one.
      const found = lookup(deviceCode, at);

      // Housekeeping, on the same terms as `start`: one comparison unless
      // something has expired. A poll creates nothing, so this is only about
      // not holding dead records until the next `start` comes along.
      expire(at);

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
          forget(key);
          return { kind: 'denied' };
        }

        case 'expired': {
          forget(key);
          return { kind: 'expired' };
        }

        case 'approved': {
          // Deleted before the account is written, not after. Everything below
          // this line can fail, and a device code that survives its own
          // redemption is a credential that mints token pairs on demand.
          forget(key);

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
 * All four map onto a code whose meaning is exactly this situation. `slow_down`
 * did not, until T-020 minted `RATE_LIMITED`: it answered `CONFLICT`, which was
 * the only code left that a caller could tell apart from "keep polling" and from
 * "stop", but whose documented meaning — a collision with existing state — has
 * nothing to do with going too fast. T-055 pointed it at the code that says what
 * it means.
 *
 * `AUTH_PENDING` and `RATE_LIMITED` are neighbours here and must not be blurred.
 * `AUTH_PENDING` is not a failure at all: nothing is wrong, the user has simply
 * not clicked yet, and the client polls again *at the same interval*.
 * `RATE_LIMITED` says the request was fine but arrived too soon, and the client
 * must poll again at a *larger* interval — the one this server just grew and
 * will keep. Two different actions, so two different codes.
 *
 * The actionable part, how long to wait, stays where HTTP already carries it: in
 * `Retry-After`, on this response and on the 428, unchanged by T-055. A client
 * reads the header; the message names the interval only for a human.
 */
function sendPollOutcome(
  outcome: PollOutcome,
  reply: FastifyReply,
): PollDeviceAuthorizationResponse {
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
        ErrorCode.RATE_LIMITED,
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
    async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<StartDeviceAuthorizationResponse> => {
      // The body carries a device code the client must store. A cache anywhere
      // between here and it would be holding a credential.
      reply.header('cache-control', 'no-store');

      parseBody(StartDeviceAuthorizationRequestSchema, request.body);
      return await service.start();
    },
  );

  app.post(
    '/auth/device/poll',
    async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<PollDeviceAuthorizationResponse> => {
      reply.header('cache-control', 'no-store');

      const body = parseBody(PollDeviceAuthorizationRequestSchema, request.body);
      return sendPollOutcome(await service.poll(body.deviceCode), reply);
    },
  );
}

/** Collaborators for {@link registerIdentityRoutes}. */
export interface IdentityRouteOptions {
  /** Spends and revokes refresh tokens. See {@link TokenRotator}. */
  readonly tokens: TokenRotator;
  /** Reads the caller's own account back. See {@link UserLookup}. */
  readonly users: UserLookup;
}

/**
 * Registers what a client does with a credential once it has one: find out
 * whose it is, renew it, and give it up.
 *
 * `GET /me`, `POST /auth/refresh` and `POST /auth/logout` (plan §3, §7).
 *
 * ## Refresh is the one route here that answers without an access token
 *
 * Not having a usable access token is the entire reason to call it, so
 * requiring one would make the route unreachable in exactly the situation it
 * exists for. That does not make it unauthenticated: the refresh token *is* the
 * credential, it is verified against a stored digest by the token service, and
 * a caller holding no valid one gets `AUTH_REQUIRED` from there instead of from
 * the guard.
 *
 * **This module does not and cannot make that decision.** `plugins/auth.ts`
 * protects every route that does not declare `config.auth = 'public'`, and the
 * only thing that stamps that flag is the `onRoute` hook in `app.ts`, from the
 * `PUBLIC_ROUTES` list. So the exception is one line at the wiring site, in the
 * same list as `/healthz` and the device flow, where it is reviewed next to the
 * whole unauthenticated surface and logged at boot — and no route module,
 * including this one, can add itself to it. Registering these three routes on
 * an application that has not listed `/auth/refresh` yields a 401 on refresh:
 * a bug report, which is the direction this design fails in.
 *
 * ## Nothing security-critical happens here
 *
 * Rotation, reuse detection, the chain revocation that answers a replay, and
 * the idempotence of a revoke are all `auth/tokens.ts`. These handlers parse a
 * body, call one method, and shape the answer. See {@link TokenRotator}.
 *
 * @param app - Fastify instance to add the routes to.
 * @param options - Collaborators; see {@link IdentityRouteOptions}.
 */
export function registerIdentityRoutes(app: FastifyInstance, options: IdentityRouteOptions): void {
  const { tokens, users: directory } = options;

  app.get('/me', async (request: FastifyRequest): Promise<GetCurrentUserResponse> => {
    // Protected by omission, like every route that is not in `PUBLIC_ROUTES`.
    // `requireUser` cannot return null here; if the wiring were ever wrong it
    // raises `INTERNAL` rather than letting an anonymous caller through.
    const user = await directory.findById(request.requireUser().id);

    if (user === undefined) {
      // A signature-valid token for an account that is no longer in the table.
      // `AUTH_REQUIRED` rather than `NOT_FOUND`, because the resource the
      // caller asked for is themselves: the honest answer is that this
      // credential no longer identifies anybody, and the remedy is to sign in
      // again rather than to try a different id.
      throw new ProtocolError(
        ErrorCode.AUTH_REQUIRED,
        'This access token belongs to an account that no longer exists. ' +
          'Sign in again with: agentchat login',
      );
    }

    return user;
  });

  app.post(
    '/auth/refresh',
    async (request: FastifyRequest, reply: FastifyReply): Promise<RefreshTokensResponse> => {
      // The body carries the replacement pair. A cache anywhere between here
      // and the client would be holding a credential.
      reply.header('cache-control', 'no-store');

      const body = parseBody(RefreshTokensRequestSchema, request.body);
      const issued = await tokens.refresh(body.refreshToken);

      // Only the two credentials. The token service also returns both expiry
      // timestamps, and `RefreshTokensResponseSchema` describes neither;
      // forwarding a wider object than the contract is how a field ends up on
      // the wire because nobody stopped it.
      return { accessToken: issued.accessToken, refreshToken: issued.refreshToken };
    },
  );

  app.post(
    '/auth/logout',
    async (request: FastifyRequest, reply: FastifyReply): Promise<LogoutResponse> => {
      reply.header('cache-control', 'no-store');

      // Authenticated, so that revoking a refresh token costs a valid access
      // token as well as the refresh token itself. The access token also has to
      // be *live*: a client whose access token has expired refreshes first, and
      // `packages/client` does exactly that before retrying.
      request.requireUser();

      const body = parseBody(LogoutRequestSchema, request.body);

      // Whether a live token was actually revoked is deliberately not reported.
      // A second logout, a logout after the token expired, and a logout with a
      // string this server never issued are all successes with the same empty
      // body — see `LogoutResponseSchema`. A client retrying after a dropped
      // connection must not be told its second attempt failed, and a caller
      // must not be able to use this route to learn whether a given string is a
      // live refresh token.
      await tokens.revoke(body.refreshToken);

      return {};
    },
  );
}
