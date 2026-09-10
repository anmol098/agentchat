/**
 * Session lifecycle: registration, heartbeat, teardown, and the sweep that
 * ends listeners nobody said goodbye for (Plan §2, §3, decision D14).
 *
 * ## What a session is
 *
 * One running `agentchat listen` process. An agent may have several at once —
 * different machines, different working directories, the same agent — so a
 * session is *not* an identity. It is minted fresh on every `listen` and never
 * reused, which is exactly why {@link messageInbox} is keyed on the agent
 * instead (D3): a durable inbox cannot hang off an ephemeral row.
 *
 * ## The common case is a process that is killed without warning
 *
 * `SIGKILL`, a closed laptop lid, a dropped network, a container evicted
 * mid-message. Plan §6.3 has the CLI send `DELETE /sessions/:id` on
 * `SIGINT`/`SIGTERM`, and that is a courtesy, not a mechanism: **nothing in
 * this module depends on a graceful goodbye.** Every session that stops
 * heartbeating ends on its own, through {@link SessionService.sweep}, and the
 * explicit teardown only makes it happen sooner. If the graceful path were
 * deleted tomorrow the only visible change would be up to
 * {@link HEARTBEAT_TIMEOUT_SECONDS} of a listener that is already dead still
 * being reported as online.
 *
 * That is the whole reason presence is derived from `status = 'active'` rather
 * than from "a row exists". A row exists forever; being active expires.
 *
 * ## Presence
 *
 * Plan §2: an agent is online in a project when it has **at least one `active`
 * session there**. `stale` is deliberately not online — a session with no
 * heartbeat for a minute is a listener that will not answer, and reporting it
 * as reachable would make `agentchat agents` lie in exactly the situation the
 * user consults it. `ended` is not online either, obviously. The one place that
 * definition lives is {@link activeSessionPredicate}, which discovery (T-401)
 * and the socket registry (T-307) are expected to build their queries on rather
 * than restating `eq(sessions.status, 'active')` in three files that then drift.
 *
 * ## Runtime is required and never inferred (D14)
 *
 * `sessions.runtime` is nullable in the database because the column must accept
 * a row written by something that is not today's CLI, and Plan §2 marks it
 * optional. The *API* is stricter than the column on purpose:
 * {@link RegisterSessionRequest.runtime} is required, and this module never
 * sniffs an environment variable, a parent process name, or a user agent to
 * fill it. A guessed runtime is wrong metadata that then reads as authoritative
 * in discovery output, which is worse than no metadata at all — so the caller,
 * which is the one component that actually knows, has to say.
 *
 * @module
 */

import {
  AgentId,
  ErrorCode,
  MachineId,
  ProjectId,
  ProtocolError,
  SessionId,
  type UserId,
} from '@stackgrid/protocol';
import { and, eq, type SQL, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { agents } from '../db/schema/agents.js';
import { machines, sessions } from '../db/schema/messaging.js';
import type { AuthorizationService } from './authorization.js';

// ---------------------------------------------------------------------------
// The lifecycle, as constants
// ---------------------------------------------------------------------------

/**
 * The three states of `sessions.status`, matching the `sessions_status_valid`
 * check in `db/schema/messaging.ts`.
 *
 * Written out here so nothing in this module or its callers spells a status as
 * a bare string literal. The database check is the enforcement; this is the
 * spelling.
 */
export const SESSION_STATUS = Object.freeze({
  /** Heartbeating. The only status that counts as present. */
  ACTIVE: 'active',
  /** Silent for longer than {@link HEARTBEAT_TIMEOUT_SECONDS}. Not present. */
  STALE: 'stale',
  /** Finished, by teardown or by the sweep. Terminal. */
  ENDED: 'ended',
} as const);

/** One of the three values `sessions_status_valid` permits. */
export type SessionStatus = (typeof SESSION_STATUS)[keyof typeof SESSION_STATUS];

/**
 * Seconds of silence after which an active session is stale (Plan §2).
 *
 * The same sixty seconds the WebSocket heartbeat uses (Plan §4.3: ping every
 * twenty, close after sixty with no pong), because they measure the same thing
 * from two directions and two different numbers would mean a socket the server
 * has already given up on still reporting its agent as online.
 */
export const HEARTBEAT_TIMEOUT_SECONDS = 60;

/** Seconds a session may stay stale before it is ended: twenty-four hours. */
export const STALE_SESSION_LIFETIME_SECONDS = 24 * 60 * 60;

/**
 * Seconds of silence after which a session is ended outright.
 *
 * Measured from `last_seen_at`, like staleness, and therefore the *sum* of the
 * two thresholds rather than the day on its own. There is no `stale_at` column
 * — three states in two columns is already the compromise
 * `sessions_ended_at_matches_status` exists to police — so "stale for a day"
 * has to be expressed against the one timestamp that is recorded. Staleness
 * begins at `last_seen_at + 60 s`, so a day of it ends at `last_seen_at + 60 s
 * + 24 h`, which is this.
 *
 * Deriving it rather than writing `86_460` also means the identity holds by
 * construction if either threshold is ever retuned.
 */
export const SESSION_END_AFTER_SECONDS = HEARTBEAT_TIMEOUT_SECONDS + STALE_SESSION_LIFETIME_SECONDS;

/**
 * How often {@link startSessionSweeper} runs by default.
 *
 * A third of the stale threshold, so a listener is reported stale within twenty
 * seconds of the moment it qualifies rather than up to a minute later. The
 * sweep is two indexed statements against the live set (`sessions_stale_sweep_idx`
 * is partial on `status = 'active'`), so running it three times a minute costs
 * nothing worth measuring.
 */
export const SESSION_SWEEP_INTERVAL_MS = 20_000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A session as a caller sees it.
 *
 * `machineName` is joined in rather than left as an opaque `mch_` id: every
 * consumer of this — `agentchat status`, discovery, a diagnostics listing —
 * wants the hostname, and none of them wants a second round trip to get it.
 */
export interface SessionRecord {
  /** `ses_` identifier. */
  readonly id: SessionId;
  /** The agent this listener speaks for. */
  readonly agentId: AgentId;
  /** The project it is listening in. */
  readonly projectId: ProjectId;
  /** The machine it runs on. */
  readonly machineId: MachineId;
  /** That machine's hostname, as the CLI reported it. */
  readonly machineName: string;
  /** The harness that opened it, verbatim from the caller (D14). */
  readonly runtime: string | null;
  /** The directory `listen` was started in. Never interpreted. */
  readonly workingDirectory: string;
  /** When it registered. */
  readonly startedAt: Date;
  /** Last heartbeat. What the sweep measures. */
  readonly lastSeenAt: Date;
  /** When it ended, or `null` while it has not. */
  readonly endedAt: Date | null;
  /** Where it is in the lifecycle. */
  readonly status: SessionStatus;
}

/** Registering a listener: who, where, and on what. */
export interface RegisterSessionRequest {
  /** The authenticated caller, from `request.requireUser()`. */
  readonly userId: UserId;
  /** The agent the listener speaks for. Must be the caller's own. */
  readonly agentId: AgentId;
  /** The project it listens in. The agent must participate in it. */
  readonly projectId: ProjectId;
  /** The machine's hostname. Upserted; see {@link upsertMachine}. */
  readonly machineName: string;
  /**
   * The harness, from the caller and only from the caller (D14).
   *
   * Required here even though the column is nullable. See the module note.
   */
  readonly runtime: string;
  /** The directory `listen` was started in. */
  readonly workingDirectory: string;
}

/** Acting on one existing session: heartbeat, teardown. */
export interface SessionOwnerRequest {
  /** The authenticated caller. */
  readonly userId: UserId;
  /** The session the route names. */
  readonly sessionId: SessionId;
}

/**
 * Listing the caller's own sessions (`GET /sessions`, `agentchat status`).
 *
 * The filters narrow; they never widen. See {@link SessionService.list}.
 */
export interface ListSessionsRequest {
  /** The authenticated caller. Their sessions and nobody else's. */
  readonly userId: UserId;
  /** Restrict to one project. */
  readonly projectId?: ProjectId | undefined;
  /** Restrict to one agent. */
  readonly agentId?: AgentId | undefined;
  /**
   * Include sessions that have already ended.
   *
   * Off by default: one row per `listen` invocation accumulates forever and
   * never becomes interesting again, so a status listing that included them
   * would bury the two live ones the user is actually asking about.
   */
  readonly includeEnded?: boolean | undefined;
}

/** What one sweep did. Counts, for a log line and for a test. */
export interface SweepResult {
  /** Active sessions that went stale in this pass. */
  readonly markedStale: number;
  /** Stale sessions that ended in this pass. */
  readonly ended: number;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** The codes a session rule may answer with. */
export type SessionFailureCode =
  | typeof ErrorCode.NOT_FOUND
  | typeof ErrorCode.CONFLICT
  | typeof ErrorCode.INTERNAL;

/**
 * The message each session failure carries.
 *
 * Total over {@link SessionFailureCode}, and looked up from the code and
 * nothing else, following `./authorization.ts`. That is what makes an imaginary
 * session id and somebody else's real one byte-identical on the wire without
 * anybody having to remember: session ids are printed to stderr by `listen`,
 * pasted into bug reports and kept in shell history, so a message that
 * distinguished the two causes would turn this endpoint into an id oracle.
 */
export const SESSION_FAILURE_MESSAGES: Readonly<Record<SessionFailureCode, string>> = Object.freeze(
  {
    [ErrorCode.NOT_FOUND]: 'No such session, or it is not one you can use.',
    [ErrorCode.CONFLICT]:
      'That session has already ended. Start a new listener with: agentchat listen --runtime <name>',
    [ErrorCode.INTERNAL]: 'The session could not be stored.',
  },
);

/**
 * Builds the failure a session rule reports.
 *
 * @param code - The contract code the caller branches on.
 * @param reason - Internal detail, for the `cause` chain and the log. Never
 *   sent; `errors.ts` does not forward a cause.
 * @returns The error to throw.
 */
function failure(code: SessionFailureCode, reason: string): ProtocolError {
  return new ProtocolError(code, SESSION_FAILURE_MESSAGES[code], { cause: new Error(reason) });
}

// ---------------------------------------------------------------------------
// Presence
// ---------------------------------------------------------------------------

/**
 * The definition of presence, as a reusable condition.
 *
 * Plan §2: online means at least one `active` session. Exported so that
 * discovery (T-401), the socket registry (T-307) and anything else asking "is
 * this agent reachable" build on one expression instead of three copies of
 * `status = 'active'` that drift the first time a fourth status is added.
 *
 * Postgres matches `sessions_project_agent_active_idx` — partial on exactly
 * this predicate — to any query whose `WHERE` implies it, so using this keeps
 * the index in play rather than costing one.
 *
 * @returns The `WHERE` fragment for a live session.
 */
export function activeSessionPredicate(): SQL {
  return eq(sessions.status, SESSION_STATUS.ACTIVE);
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * The parts of the Drizzle handle this service uses.
 *
 * Narrowed the way `routes/auth.ts` narrows `UserDirectoryDatabase`: the
 * service cannot quietly grow a use for the pool, and a caller may pass a
 * handle typed with any schema. `delete` is deliberately absent — nothing here
 * removes a session row, and the type says so.
 */
export type SessionDatabase = Pick<
  NodePgDatabase<Record<string, never>>,
  'select' | 'insert' | 'update'
>;

/** Options for {@link createSessionService}. */
export interface SessionServiceOptions {
  /** Database or transaction handle. */
  readonly db: SessionDatabase;
  /**
   * The access rules.
   *
   * Injected rather than constructed here so that this module states which
   * rules it applies and re-derives none of them. Registration is
   * `assertOwnAgentInProject`; heartbeat and teardown are `assertAgentOwner`.
   */
  readonly authorization: AuthorizationService;
  /** Seconds of silence before a session is stale. Defaults to the plan's sixty. */
  readonly staleAfterSeconds?: number | undefined;
  /**
   * Seconds of silence before a session is ended.
   *
   * Defaults to {@link SESSION_END_AFTER_SECONDS}. Configurable because a
   * deployment may want a shorter tail, and because a test should be able to
   * drive a transition without either waiting a day or mocking a clock the
   * database does not use.
   */
  readonly endAfterSeconds?: number | undefined;
}

/**
 * Session lifecycle, bound to a database handle and the access rules.
 *
 * Every method either returns the row it wrote or throws a
 * {@link ProtocolError} carrying a contract code.
 */
export interface SessionService {
  /**
   * Registers a listener.
   *
   * Records agent, project, machine, runtime and working directory, upserting
   * the machine by `(user, hostname)`. The session is `active` from this
   * instant and stays so until it stops heartbeating.
   *
   * @param request - Who, where, and on what. See {@link RegisterSessionRequest}.
   * @returns The registered session.
   * @throws {ProtocolError} Whatever `assertOwnAgentInProject` reports —
   *   `NOT_FOUND` when the caller is not in the project or the agent is not
   *   theirs, `AGENT_DELETED`, `AGENT_NOT_IN_PROJECT` — or `INTERNAL` if the
   *   row could not be written.
   */
  register(request: RegisterSessionRequest): Promise<SessionRecord>;

  /**
   * Records a heartbeat.
   *
   * Bumps `last_seen_at` on the session and on its machine. A `stale` session
   * is returned to `active`: staleness is an inference from silence, and a
   * heartbeat is that inference being contradicted — a healed network partition
   * or a machine back from suspend. An `ended` session is **not** revived;
   * `ended` is terminal, and quietly resurrecting one would leave the client
   * believing in a session the sweeper had already written off.
   *
   * @param request - Caller and session.
   * @returns The session, with its refreshed timestamps.
   * @throws {ProtocolError} `NOT_FOUND` when no such session exists or it is
   *   not the caller's; `CONFLICT` when it has already ended;
   *   `AGENT_DELETED` when the caller's own agent has been soft-deleted.
   */
  heartbeat(request: SessionOwnerRequest): Promise<SessionRecord>;

  /**
   * Ends a session (`DELETE /sessions/:id`).
   *
   * The row is never removed — `deliveries` and `message_inbox.acked_by_session_id`
   * point at it — so this moves `status` to `'ended'` and stamps `ended_at`.
   *
   * Idempotent, as `DELETE` is required to be: ending an already-ended session
   * returns it unchanged rather than failing, so a client that retries after a
   * dropped response is not told its own teardown went wrong.
   *
   * @param request - Caller and session.
   * @returns The ended session.
   * @throws {ProtocolError} `NOT_FOUND` when no such session exists or it is
   *   not the caller's; `AGENT_DELETED` when the caller's own agent has been
   *   soft-deleted.
   */
  end(request: SessionOwnerRequest): Promise<SessionRecord>;

  /**
   * Records that a session's listener is gone (T-041).
   *
   * Written for `websocket/heartbeat.ts`, which declared the port it needed as
   * `SessionStaleMarker` rather than reaching into this file, and which is the
   * only caller: a socket that closes — because the peer went away, because the
   * heartbeat reaped it, or because the client said goodbye — is evidence that
   * the listener behind that session is not there any more.
   *
   * `active` **and** `stale` both move to `stale`, and `last_seen_at` is
   * refreshed either way. Marking an already-stale session stale again is a
   * no-op that still moves the timestamp forward, so a reconnect-then-drop
   * cycle does not age a session faster than the disconnections themselves.
   *
   * ## An ended session is not an error
   *
   * This is the one place where the semantics deliberately differ from
   * {@link SessionService.heartbeat}, which answers `CONFLICT` for an ended
   * session. A heartbeat on an ended session is a client bug; a *close* on one
   * is the client behaving properly. `agentchat listen` calls
   * `DELETE /sessions/:id` and then lets its socket close, in that order, so
   * refusing this would make every clean exit log a failure — and the log is
   * all there is, because `heartbeat.ts` has no socket left to report to.
   *
   * So an ended session is returned unchanged, like a retried teardown. The
   * guard is in the statement as well as in the branch, which is what keeps a
   * session the sweeper ended between the read and the write from being
   * resurrected into a state `sessions_ended_at_matches_status` would reject.
   *
   * Scoped to the caller like every other session mutation, through
   * {@link requireOwnSession}: a socket carries its own `SocketIdentity`, and
   * that identity is what decides which row it may touch.
   *
   * @param request - The socket's own user and session.
   * @returns The session, stale, or unchanged if it had already ended.
   * @throws {ProtocolError} `NOT_FOUND` when no such session exists or it is
   *   not the caller's; `AGENT_DELETED` when the caller's own agent has been
   *   soft-deleted under it. Both are raised before the status is read, so a
   *   deleted agent's ended session still reports `AGENT_DELETED`; the caller
   *   logs either and correctness does not depend on the write (see
   *   `HeartbeatService.closed`).
   */
  markStale(request: SessionOwnerRequest): Promise<SessionRecord>;

  /**
   * Lists the caller's own sessions.
   *
   * Scoped by a join on `agents.user_id`, not by a filter applied afterwards,
   * so the statement is structurally incapable of returning somebody else's
   * session. The optional filters therefore only ever narrow: a caller who
   * passes a stranger's `agentId` receives an empty list, which discloses
   * nothing, rather than a refusal that would confirm the id exists.
   *
   * @param request - Caller and filters. See {@link ListSessionsRequest}.
   * @returns Matching sessions, newest first.
   */
  list(request: ListSessionsRequest): Promise<SessionRecord[]>;

  /**
   * Ages sessions on: `active` → `stale` → `ended`.
   *
   * Safe to run repeatedly and safe to run concurrently with itself. See
   * {@link createSessionService} for why neither property needs a lock.
   *
   * @returns How many rows each half moved.
   */
  sweep(): Promise<SweepResult>;
}

/** The columns a session listing and every mutation return. */
const SESSION_COLUMNS = {
  id: sessions.id,
  agentId: sessions.agentId,
  projectId: sessions.projectId,
  machineId: sessions.machineId,
  machineName: machines.name,
  runtime: sessions.runtime,
  workingDirectory: sessions.workingDirectory,
  startedAt: sessions.startedAt,
  lastSeenAt: sessions.lastSeenAt,
  endedAt: sessions.endedAt,
  status: sessions.status,
} as const;

/** The shape {@link SESSION_COLUMNS} selects. */
interface SessionRow {
  readonly id: string;
  readonly agentId: string;
  readonly projectId: string;
  readonly machineId: string;
  readonly machineName: string;
  readonly runtime: string | null;
  readonly workingDirectory: string;
  readonly startedAt: Date;
  readonly lastSeenAt: Date;
  readonly endedAt: Date | null;
  readonly status: string;
}

/**
 * The instant this many seconds ago, according to the **database**.
 *
 * Every timestamp this module writes comes from `now()` and every threshold it
 * compares against is derived from `now()`, so the whole lifecycle is measured
 * on one clock. A JavaScript `Date` computed in this process would introduce a
 * second one, and two servers whose clocks disagree by a minute would then
 * disagree about which listeners are alive — with the sixty-second threshold,
 * by all of it.
 *
 * @param seconds - How far back to look.
 * @returns The cutoff, as SQL.
 */
function agoInDatabaseTime(seconds: number): SQL {
  return sql`now() - make_interval(secs => ${seconds})`;
}

/**
 * Reads a row back as a {@link SessionRecord}.
 *
 * `status` is narrowed by a cast rather than parsed: `sessions_status_valid` is
 * compiled into the database, so a value outside the three is not reachable
 * without a migration that removed the check.
 *
 * @param row - A row selected through {@link SESSION_COLUMNS}.
 * @returns The record.
 */
function toRecord(row: SessionRow): SessionRecord {
  return {
    id: SessionId.unsafeCast(row.id),
    agentId: AgentId.unsafeCast(row.agentId),
    projectId: ProjectId.unsafeCast(row.projectId),
    machineId: MachineId.unsafeCast(row.machineId),
    machineName: row.machineName,
    runtime: row.runtime,
    workingDirectory: row.workingDirectory,
    startedAt: row.startedAt,
    lastSeenAt: row.lastSeenAt,
    endedAt: row.endedAt,
    status: row.status as SessionStatus,
  };
}

/**
 * Creates the session service.
 *
 * ## Why the sweep needs no lock
 *
 * Both halves are a single `UPDATE` whose `WHERE` names the status it is moving
 * *from*. That makes each one a compare-and-set, and compare-and-set is what
 * makes the sweep idempotent and concurrency-safe at the same time:
 *
 * - **Idempotent.** A second pass over the same rows matches nothing, because
 *   the first pass changed the status the `WHERE` requires. Running it a
 *   hundred times has the effect of running it once.
 * - **Safe against another sweeper.** Under `READ COMMITTED`, an `UPDATE` that
 *   blocks on a row another transaction is updating re-evaluates its `WHERE`
 *   against the *committed* version when the lock is released. The second
 *   sweeper therefore sees `status = 'stale'`, its predicate `status = 'active'`
 *   no longer holds, and it skips the row rather than writing over the first
 *   sweeper's work or double-counting it. This is the property that matters
 *   when v0.2 runs more than one instance (Plan §8); it is a property of the
 *   statements, not of any coordination between them.
 * - **Safe against a live listener.** A heartbeat arriving mid-sweep is the
 *   same race in the other direction, and it resolves the same way: whichever
 *   commits second re-checks its own predicate. The worst outcome is a session
 *   marked stale a heartbeat too late, corrected by the next heartbeat.
 *
 * An advisory lock would add a failure mode (a sweeper that dies holding it) to
 * buy mutual exclusion the correctness argument does not need, so there is
 * none. The two statements are likewise not wrapped in a transaction: each is
 * atomic on its own, and a pass interrupted between them is simply finished by
 * the next one.
 *
 * @param options - Collaborators and thresholds. See {@link SessionServiceOptions}.
 * @returns The service.
 */
export function createSessionService(options: SessionServiceOptions): SessionService {
  const { db, authorization } = options;
  const staleAfterSeconds = options.staleAfterSeconds ?? HEARTBEAT_TIMEOUT_SECONDS;
  const endAfterSeconds = options.endAfterSeconds ?? SESSION_END_AFTER_SECONDS;

  /**
   * Resolves a machine by `(user, hostname)`, creating it if it is new.
   *
   * One statement, `ON CONFLICT … DO UPDATE`, deliberately rather than
   * `DO NOTHING`: on a conflict `DO NOTHING` returns no row, so the caller must
   * follow up with a `SELECT`, and two `listen` invocations starting together
   * on one laptop would race between the two — both insert, both conflict, both
   * select, and whichever ordering the planner picks decides whether one of
   * them sees nothing at all. `DO UPDATE` always returns the surviving row, so
   * the second caller learns the first caller's `mch_` id from the statement
   * that collided with it. The `machines_user_id_name_key` unique index is what
   * makes that arbitration possible, and is why two sessions on one machine
   * cannot produce two machine rows.
   *
   * The update also refreshes `last_seen_at`, which is what that column means.
   *
   * @param userId - Whose machine it is.
   * @param name - The hostname the CLI reported.
   * @returns The machine's identifier.
   * @throws {ProtocolError} `INTERNAL` if the upsert returned nothing, which
   *   `DO UPDATE` makes unreachable short of a dropped unique index.
   */
  async function upsertMachine(userId: UserId, name: string): Promise<MachineId> {
    const rows = await db
      .insert(machines)
      .values({ id: MachineId.generate(), userId, name })
      .onConflictDoUpdate({
        target: [machines.userId, machines.name],
        set: { lastSeenAt: sql`now()` },
      })
      .returning({ id: machines.id });

    const row = rows[0];
    if (row === undefined) {
      throw failure(ErrorCode.INTERNAL, 'The machine upsert returned no row.');
    }

    return MachineId.unsafeCast(row.id);
  }

  /**
   * Reads one session by id, with its machine's hostname.
   *
   * Unscoped on purpose: ownership is a rule, and a rule belongs to
   * `./authorization.ts`. {@link requireOwnSession} is what puts the two
   * together, and what makes sure the answer to "not yours" is the same as the
   * answer to "no such thing".
   *
   * @param sessionId - The session the route names.
   * @returns The row, or `undefined`.
   */
  async function selectSession(sessionId: SessionId): Promise<SessionRecord | undefined> {
    const rows = await db
      .select(SESSION_COLUMNS)
      .from(sessions)
      .innerJoin(machines, eq(machines.id, sessions.machineId))
      .where(eq(sessions.id, sessionId))
      .limit(1);

    const row = rows[0];
    return row === undefined ? undefined : toRecord(row);
  }

  /**
   * Resolves a session the caller is entitled to act on.
   *
   * Two steps, and the second is not a query this module wrote: the session is
   * read, then `assertAgentOwner` decides whether the caller may touch it. That
   * assertion also carries agent liveness, so a listener whose agent was
   * soft-deleted under it (D13, T-109) is told `AGENT_DELETED` — the one answer
   * that names a remedy — rather than being allowed to heartbeat a session that
   * a soft delete has already ended.
   *
   * Project membership is deliberately *not* asserted. A user who has left the
   * project their listener runs in must still be able to end it; refusing would
   * leave a session nobody can turn off, reported as online until the sweep
   * catches it a day later.
   *
   * ## One answer for two causes
   *
   * `assertAgentOwner`'s `NOT_FOUND` is re-thrown as this module's, so a
   * stranger's real session id and a completely invented one produce the same
   * status, the same code and the same bytes. Without the translation the two
   * would differ by the message text alone, which is exactly the kind of
   * difference an id oracle is built out of. `AGENT_DELETED` is passed through
   * untouched because it is only ever raised for the caller's *own* agent, so
   * it discloses nothing they do not already know.
   *
   * @param request - Caller and session.
   * @returns The session.
   * @throws {ProtocolError} `NOT_FOUND` or `AGENT_DELETED`, as above.
   */
  async function requireOwnSession(request: SessionOwnerRequest): Promise<SessionRecord> {
    const session = await selectSession(request.sessionId);
    if (session === undefined) {
      throw failure(ErrorCode.NOT_FOUND, `No session ${request.sessionId}.`);
    }

    try {
      await authorization.assertAgentOwner({
        userId: request.userId,
        agentId: session.agentId,
      });
    } catch (cause: unknown) {
      if (cause instanceof ProtocolError && cause.code === ErrorCode.NOT_FOUND) {
        throw failure(
          ErrorCode.NOT_FOUND,
          `Session ${request.sessionId} belongs to an agent the caller does not own.`,
        );
      }
      throw cause;
    }

    return session;
  }

  return {
    async register(request: RegisterSessionRequest): Promise<SessionRecord> {
      // The composite rule, applied before anything is written: the caller must
      // be in the project, and the agent must be theirs, live, and a
      // participant. Registering a listener is acting *as* an agent, which is
      // precisely what `assertOwnAgentInProject` decides.
      await authorization.assertOwnAgentInProject({
        userId: request.userId,
        agentId: request.agentId,
        projectId: request.projectId,
      });

      // Not in a transaction with the insert below, deliberately. The machine
      // row is idempotent by `(user, hostname)` and means nothing on its own —
      // it is a hostname and a timestamp — so a session insert that fails
      // afterwards leaves nothing to clean up and nothing a later registration
      // will not simply reuse. A transaction would hold a connection open
      // across the whole of the registration path to buy tidiness in a case
      // that is already tidy.
      const machineId = await upsertMachine(request.userId, request.machineName);

      const inserted = await db
        .insert(sessions)
        .values({
          id: SessionId.generate(),
          agentId: request.agentId,
          projectId: request.projectId,
          machineId,
          // Verbatim. Never sniffed, never defaulted, never normalised (D14).
          runtime: request.runtime,
          workingDirectory: request.workingDirectory,
        })
        .returning({ id: sessions.id });

      const row = inserted[0];
      if (row === undefined) {
        throw failure(ErrorCode.INTERNAL, 'The session insert returned no row.');
      }

      const session = await selectSession(SessionId.unsafeCast(row.id));
      if (session === undefined) {
        throw failure(ErrorCode.INTERNAL, 'The session vanished between insert and read.');
      }

      return session;
    },

    async heartbeat(request: SessionOwnerRequest): Promise<SessionRecord> {
      const session = await requireOwnSession(request);

      if (session.status === SESSION_STATUS.ENDED) {
        // Terminal. The client's remedy is a new `listen`, and the message says
        // so; reviving the row would hand it back a session the sweeper has
        // already accounted for.
        throw failure(ErrorCode.CONFLICT, `Session ${session.id} has ended.`);
      }

      // `active` and `stale` are both refreshed to `active` in one statement,
      // so a heartbeat that arrives during a sweep is a plain compare-and-set
      // against whichever status won rather than a read-then-write.
      await db
        .update(sessions)
        .set({ lastSeenAt: sql`now()`, status: SESSION_STATUS.ACTIVE })
        .where(
          and(
            eq(sessions.id, session.id),
            // Never revive a session the sweep ended between the read above and
            // this write. The guard is in the statement, not in the `if`.
            eq(sessions.status, session.status),
          ),
        );

      // `machines.last_seen_at` means "a session on this machine registered or
      // heartbeated", per its own documentation in the schema.
      await db
        .update(machines)
        .set({ lastSeenAt: sql`now()` })
        .where(eq(machines.id, session.machineId));

      const refreshed = await selectSession(session.id);
      if (refreshed === undefined) {
        throw failure(ErrorCode.INTERNAL, 'The session vanished during a heartbeat.');
      }

      return refreshed;
    },

    async end(request: SessionOwnerRequest): Promise<SessionRecord> {
      const session = await requireOwnSession(request);

      if (session.status === SESSION_STATUS.ENDED) {
        // Idempotent: a retried `DELETE` after a dropped response is the same
        // request, and answering it with a failure would tell a client its own
        // teardown went wrong when it did not.
        return session;
      }

      await db
        .update(sessions)
        .set({ status: SESSION_STATUS.ENDED, endedAt: sql`now()` })
        // Not already ended — which is what keeps `ended_at` the instant the
        // session first ended rather than the instant of the last retry, and
        // what makes a teardown racing the sweeper a no-op instead of a
        // rewrite.
        .where(
          and(eq(sessions.id, session.id), sql`${sessions.status} <> ${SESSION_STATUS.ENDED}`),
        );

      const ended = await selectSession(session.id);
      if (ended === undefined) {
        throw failure(ErrorCode.INTERNAL, 'The session vanished while ending.');
      }

      return ended;
    },

    async markStale(request: SessionOwnerRequest): Promise<SessionRecord> {
      const session = await requireOwnSession(request);

      if (session.status === SESSION_STATUS.ENDED) {
        // Not a conflict. A socket closing after `DELETE /sessions/:id` is the
        // order `agentchat listen` shuts down in; see the interface note.
        return session;
      }

      // One statement for `active` and `stale` alike, so a close that arrives
      // during a sweep is a compare-and-set rather than a read-then-write. The
      // timestamp moves in both cases: `last_seen_at` means "the last evidence
      // of this listener", and a disconnection is evidence of when it was last
      // there.
      await db
        .update(sessions)
        .set({ lastSeenAt: sql`now()`, status: SESSION_STATUS.STALE })
        // Never revive a session that ended between the read above and this
        // write — the sweeper may have ended it, or the client's own
        // `DELETE` may have landed in between. Writing `stale` over `ended`
        // would also leave `ended_at` set on a row that is not ended, which
        // `sessions_ended_at_matches_status` refuses outright.
        .where(
          and(eq(sessions.id, session.id), sql`${sessions.status} <> ${SESSION_STATUS.ENDED}`),
        );

      const marked = await selectSession(session.id);
      if (marked === undefined) {
        throw failure(ErrorCode.INTERNAL, 'The session vanished while being marked stale.');
      }

      return marked;
    },

    async list(request: ListSessionsRequest): Promise<SessionRecord[]> {
      // Driven from `agents` with the owner in the join, so the statement
      // cannot return a session belonging to somebody else. The check is in the
      // SQL, not in a filter after it.
      const conditions: SQL[] = [eq(agents.userId, request.userId)];

      if (request.projectId !== undefined) {
        conditions.push(eq(sessions.projectId, request.projectId));
      }
      if (request.agentId !== undefined) {
        conditions.push(eq(sessions.agentId, request.agentId));
      }
      if (request.includeEnded !== true) {
        conditions.push(sql`${sessions.status} <> ${SESSION_STATUS.ENDED}`);
      }

      const rows = await db
        .select(SESSION_COLUMNS)
        .from(sessions)
        .innerJoin(agents, eq(agents.id, sessions.agentId))
        .innerJoin(machines, eq(machines.id, sessions.machineId))
        .where(and(...conditions))
        .orderBy(sql`${sessions.startedAt} desc`);

      return rows.map(toRecord);
    },

    async sweep(): Promise<SweepResult> {
      // Compare-and-set, half one. See the note on `createSessionService` for
      // why this is all the concurrency control there is.
      const staled = await db
        .update(sessions)
        .set({ status: SESSION_STATUS.STALE })
        .where(
          and(
            eq(sessions.status, SESSION_STATUS.ACTIVE),
            sql`${sessions.lastSeenAt} < ${agoInDatabaseTime(staleAfterSeconds)}`,
          ),
        )
        .returning({ id: sessions.id });

      // Half two, and it runs *after* half one on purpose: a session silent for
      // longer than both thresholds is marked stale and then ended within a
      // single pass, rather than needing two. `ended_at` is set in the same
      // statement because `sessions_ended_at_matches_status` will not accept
      // the pair disagreeing even momentarily.
      const ended = await db
        .update(sessions)
        .set({ status: SESSION_STATUS.ENDED, endedAt: sql`now()` })
        .where(
          and(
            eq(sessions.status, SESSION_STATUS.STALE),
            sql`${sessions.lastSeenAt} < ${agoInDatabaseTime(endAfterSeconds)}`,
          ),
        )
        .returning({ id: sessions.id });

      return { markedStale: staled.length, ended: ended.length };
    },
  };
}

// ---------------------------------------------------------------------------
// The timer
// ---------------------------------------------------------------------------

/** What {@link startSessionSweeper} reports a completed pass to. */
export interface SweeperObserver {
  /**
   * Called after every pass that moved at least one row.
   *
   * @param result - The counts.
   */
  onSwept?(result: SweepResult): void;
  /**
   * Called when a pass threw.
   *
   * A failed sweep is not fatal — the next pass repeats the same work, because
   * the statements are idempotent — so it is reported rather than rethrown into
   * a timer callback nobody can catch.
   *
   * @param error - Whatever the pass threw.
   */
  onFailed?(error: unknown): void;
}

/** Options for {@link startSessionSweeper}. */
export interface SweeperOptions {
  /** The service whose {@link SessionService.sweep} to call. */
  readonly sessions: SessionService;
  /** Milliseconds between passes. Defaults to {@link SESSION_SWEEP_INTERVAL_MS}. */
  readonly intervalMs?: number | undefined;
  /** Where results and failures go. Wire this to the process logger. */
  readonly observer?: SweeperObserver | undefined;
}

/** A running sweeper. Stop it during shutdown so the process can exit. */
export interface Sweeper {
  /** Stops the timer. Safe to call more than once. */
  stop(): void;
}

/**
 * Runs {@link SessionService.sweep} on a timer.
 *
 * The timer is `unref`ed, so a sweeper that nobody stopped cannot by itself
 * keep the process alive — the same reasoning that keeps `pino` writing
 * synchronously in `app.ts`: shutdown should be decided by the server, not by a
 * background interval.
 *
 * Passes never overlap. A pass that is still running when the interval fires
 * simply skips that tick, because two overlapping passes would be two sweepers
 * in one process, and while the statements survive that (see
 * {@link createSessionService}) there is no reason to arrange it.
 *
 * This is exported rather than started here: `app.ts` belongs to the wiring
 * task, and a module that starts its own timer on import is a module a test
 * cannot host.
 *
 * @param options - See {@link SweeperOptions}.
 * @returns A handle that stops the timer.
 */
export function startSessionSweeper(options: SweeperOptions): Sweeper {
  const intervalMs = options.intervalMs ?? SESSION_SWEEP_INTERVAL_MS;
  const observer = options.observer;

  let running = false;

  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;

    options.sessions
      .sweep()
      .then((result) => {
        if (result.markedStale > 0 || result.ended > 0) {
          observer?.onSwept?.(result);
        }
      })
      .catch((error: unknown) => {
        observer?.onFailed?.(error);
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);

  timer.unref();

  return {
    stop(): void {
      clearInterval(timer);
    },
  };
}
