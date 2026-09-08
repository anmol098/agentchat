/**
 * The agent lifecycle: create, list, rename, join a project, leave a project,
 * and the soft delete D13 specifies.
 *
 * `services/authorization.ts` answers *may they*. This module answers *do it*,
 * and it never re-derives a rule: every entry point below opens with an
 * assertion from that service and works from the row the assertion returns.
 * The one thing it adds is that the assertion runs **inside** the same
 * transaction as the write it guards, so nothing changes between the check and
 * the change.
 *
 * ## Soft delete is three writes or none (D13, Plan §2)
 *
 * `DELETE /agents/:id` does not remove a row. It:
 *
 * 1. stamps `agents.deleted_at` — the tombstone, and the whole of it;
 * 2. deletes the agent's `agent_projects` rows, because participation is a
 *    capability rather than a record of anything (see the note in
 *    `db/schema/agents.ts`);
 * 3. ends every session the agent holds, because a session is a live
 *    subscription and a deleted agent has nothing to subscribe to.
 *
 * All three happen in one transaction. A half-applied delete is not a smaller
 * version of a delete, it is a different and worse state: an agent with a
 * tombstone but live `agent_projects` rows is *deleted and still addressable* —
 * exactly the zombie `services/authorization.ts` guards against by checking
 * liveness before participation, and exactly the case its suite tests. That
 * guard is a second line of defence, not a licence to leave the rows behind.
 * If any of the three fails, the transaction rolls back and the agent is still
 * live, still joined, still listening: a delete that did not happen, which the
 * caller can retry. `agents.integration.test.ts` proves this against a real
 * failure rather than a mocked one.
 *
 * Historical messages are untouched, which is the entire reason the delete is
 * soft: `messages.sender_agent_id` and `messages.recipient_agent_id` reference
 * `agents` with `ON DELETE RESTRICT` precisely so a March conversation is still
 * readable in September.
 *
 * ## A name is not an identity
 *
 * Deleting frees the name — `agents_user_id_name_live_idx` is predicated on
 * `deleted_at is null`, so a tombstone is outside the index rather than
 * exempted by it — and creating mints a **new** identifier. `backend`
 * recreated after `backend` was deleted is a different agent that happens to
 * answer at the same address, and the old messages still belong to the old one.
 *
 * So nothing here maps a name to an identity. `create` always generates an id
 * and never looks for a tombstone to revive; `rename` moves a name between live
 * rows and never consults a deleted one. Every lookup a caller can reach is by
 * `AgentId`.
 *
 * ## Every read filters on the tombstone, literally
 *
 * `agents_user_id_name_live_idx` is a partial index on `(user_id, name) where
 * deleted_at is null`. Postgres will only match it to a query whose `WHERE`
 * implies that predicate, so each statement here spells `deleted_at is null`
 * out rather than deriving liveness some other way. It is also why there is no
 * separate index on `user_id`: this one already answers "which agents does this
 * user have" from its leading column, for the only rows a caller ever wants.
 *
 * The same clause is repeated on the *writes* even though an assertion has
 * already established liveness. That is not belt and braces — it is the write's
 * own guard: two concurrent deletes both pass the assertion, and the second one
 * updates zero rows and is reported as `AGENT_DELETED` instead of silently
 * re-stamping a tombstone with a later timestamp.
 *
 * @module
 */

import {
  AgentId,
  ErrorCode,
  type ProjectId,
  ProtocolError,
  type UserId,
} from '@agentchat/protocol';
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import { agentProjects, agents } from '../db/schema/agents.js';
import { sessions } from '../db/schema/messaging.js';
import { type AgentRecord, createAuthorizationService } from './authorization.js';

// ---------------------------------------------------------------------------
// The database surface
// ---------------------------------------------------------------------------

/**
 * The part of a Drizzle handle a statement in this module needs.
 *
 * A `Pick` of `PgDatabase` rather than of `NodePgDatabase`, for the reason
 * `services/authorization.ts` gives for the same trick: a pool handle and a
 * transaction handle are different types parameterised by different schemas,
 * and both satisfy this.
 */
export type AgentWriter = Pick<
  PgDatabase<PgQueryResultHKT>,
  'select' | 'insert' | 'update' | 'delete'
>;

/**
 * A handle that can also open a transaction.
 *
 * The service is built over one of these rather than over a bare
 * {@link AgentWriter} because the delete has no meaning without a transaction:
 * a service that could not open one would be a service that could only
 * half-delete.
 */
export interface AgentServiceDatabase extends AgentWriter {
  /**
   * Runs `work` inside a database transaction, committing on return and rolling
   * back on a throw.
   *
   * @param work - The statements to run atomically.
   * @returns Whatever `work` returned.
   */
  transaction<T>(work: (tx: AgentWriter) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Failures the database reports
// ---------------------------------------------------------------------------

/** Postgres' `unique_violation`. */
const UNIQUE_VIOLATION = '23505';

/**
 * The partial unique index that makes a name unique among a user's live agents.
 *
 * Named here so a collision on it can be answered with `CONFLICT` and a
 * collision on anything else — an id, which the server mints and which
 * colliding would mean something has gone badly wrong — is not quietly
 * reported as the caller's fault.
 */
const LIVE_NAME_INDEX = 'agents_user_id_name_live_idx';

/**
 * Whether a thrown value is a Postgres unique violation on a given constraint.
 *
 * Walks the cause chain because Drizzle wraps driver errors, and matches the
 * constraint name so one collision is not mistaken for another. `routes/auth.ts`
 * has the same function for the same reason; it is private there, and widening
 * a finished task's exports to save ten lines is not a trade this module makes.
 *
 * @param error - Whatever was thrown.
 * @param constraintFragment - Substring of the constraint or index name.
 * @returns `true` when the driver reported a unique violation naming it.
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
 * The message a name collision carries.
 *
 * States the rule rather than the row, because the colliding agent may be one
 * the caller forgot they had and naming it back to them adds nothing they
 * cannot see with `agentchat agent list`.
 */
export const AGENT_NAME_TAKEN_MESSAGE =
  'You already have a live agent with this name. Names are unique among your live agents; ' +
  'a name freed by deleting an agent can be reused.';

/**
 * The message a lost race to delete carries.
 *
 * `AGENT_DELETED` rather than `NOT_FOUND`: the caller demonstrably held a valid
 * id, so nothing is disclosed, and the remedy differs — their copy is stale
 * rather than wrong.
 */
export const AGENT_ALREADY_DELETED_MESSAGE =
  'This agent has already been deleted. Its messages are kept; its name is free to reuse.';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * The columns an agent is returned by.
 *
 * `deleted_at` is deliberately absent: every row this module returns is live —
 * by an assertion, or by a `where` that spells the predicate out — so a caller
 * holding one cannot forget to test it. The same reasoning, and the same shape,
 * as `AgentRecord` in `services/authorization.ts`, which this reuses rather
 * than restates.
 */
const AGENT_COLUMNS = {
  id: agents.id,
  userId: agents.userId,
  name: agents.name,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
} as const;

/** The shape {@link AGENT_COLUMNS} selects. */
interface AgentRow {
  /** `agt_` identifier, as `text`. */
  readonly id: string;
  /** `usr_` identifier, as `text`. */
  readonly userId: string;
  /** The agent's name. */
  readonly name: string;
  /** When the agent was registered. */
  readonly createdAt: Date;
  /** When the row last changed. */
  readonly updatedAt: Date;
}

/**
 * Brands a selected row as an {@link AgentRecord}.
 *
 * The identifiers are `text` in the database and branded strings in the
 * protocol. They were parsed on the way in — the id came from `AgentId.parse`
 * at the route boundary or from `AgentId.generate` here, the owner from the
 * verified token — and re-parsing them would spend a round of validation on the
 * server's own writes.
 *
 * @param row - A row selected with {@link AGENT_COLUMNS}.
 * @returns The same row, typed.
 */
function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    id: AgentId.unsafeCast(row.id),
    userId: row.userId as UserId,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Whose agents to list. */
export interface ListAgentsRequest {
  /** The authenticated caller. Only their own agents are listed. */
  readonly userId: UserId;
}

/** Who is creating an agent, and what to call it. */
export interface CreateAgentRequest {
  /** The authenticated caller, who becomes the owner. */
  readonly userId: UserId;
  /** The name, already validated against `AgentNameSchema` by the route. */
  readonly name: string;
}

/** Who is renaming which agent, and to what. */
export interface RenameAgentRequest {
  /** The authenticated caller. Must own the agent. */
  readonly userId: UserId;
  /** The agent to rename. */
  readonly agentId: AgentId;
  /** The new name, already validated by the route. */
  readonly name: string;
}

/** Who is deleting which agent. */
export interface DeleteAgentRequest {
  /** The authenticated caller. Must own the agent. */
  readonly userId: UserId;
  /** The agent to retire. */
  readonly agentId: AgentId;
}

/** Who is moving which agent in or out of which project. */
export interface AgentProjectRequest {
  /** The authenticated caller. Must own the agent. */
  readonly userId: UserId;
  /** The agent. */
  readonly agentId: AgentId;
  /** The project. */
  readonly projectId: ProjectId;
}

/**
 * What a soft delete did.
 *
 * Not part of the HTTP response — `DeleteAgentResponseSchema` has no fields,
 * deliberately — but returned so the route can log the three counts together.
 * An operator reading "deleted agt_…: 2 projects, 3 sessions" can tell a
 * complete delete from one that found nothing, which a bare 200 cannot.
 */
export interface AgentDeletion {
  /** The agent that was retired. */
  readonly agentId: AgentId;
  /** The tombstone that was stamped. */
  readonly deletedAt: Date;
  /** How many `agent_projects` rows were removed. */
  readonly projectsLeft: number;
  /** How many sessions were moved to `ended`. */
  readonly sessionsEnded: number;
}

/** What removing an agent from one project did. */
export interface AgentProjectRemoval {
  /** Whether a participation row was actually there to remove. */
  readonly removed: boolean;
  /** How many of the agent's sessions in that project were ended. */
  readonly sessionsEnded: number;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * The agent lifecycle, bound to a database handle.
 *
 * Every method takes the caller's own `userId` from the verified token and
 * checks it through `services/authorization.ts`. None of them accepts a name as
 * a way of naming an existing agent; see the module note on why a name is not
 * an identity.
 */
export interface AgentService {
  /**
   * Lists the caller's live agents, by name.
   *
   * Never another user's — `GET /projects/:id/agents` is the discovery
   * endpoint — and never a deleted one.
   *
   * @param request - The caller.
   * @returns Their live agents, ordered by name.
   */
  list(request: ListAgentsRequest): Promise<AgentRecord[]>;

  /**
   * Creates an agent owned by the caller.
   *
   * Mints a fresh identifier every time, including when the name was previously
   * used by an agent the caller deleted.
   *
   * @param request - Caller and name.
   * @returns The new agent.
   * @throws {ProtocolError} `CONFLICT` when the caller already has a live agent
   *   with this name.
   */
  create(request: CreateAgentRequest): Promise<AgentRecord>;

  /**
   * Renames one of the caller's live agents.
   *
   * @param request - Caller, agent and new name.
   * @returns The agent as it now stands, with a bumped `updatedAt`.
   * @throws {ProtocolError} `NOT_FOUND` when the agent does not exist or is
   *   somebody else's; `AGENT_DELETED` when it has been deleted; `CONFLICT`
   *   when the new name belongs to another live agent of theirs.
   */
  rename(request: RenameAgentRequest): Promise<AgentRecord>;

  /**
   * Soft-deletes one of the caller's agents: tombstone, participation,
   * sessions, in one transaction.
   *
   * @param request - Caller and agent.
   * @returns What the delete did, for the operator log.
   * @throws {ProtocolError} `NOT_FOUND` when the agent does not exist or is
   *   somebody else's; `AGENT_DELETED` when it was already deleted, including
   *   by a request that raced this one.
   */
  delete(request: DeleteAgentRequest): Promise<AgentDeletion>;

  /**
   * Adds one of the caller's live agents to a project the caller is in.
   *
   * Idempotent: joining a project the agent is already in succeeds and changes
   * nothing.
   *
   * @param request - Caller, agent, project.
   * @returns `true` when a row was added, `false` when the agent was already
   *   participating.
   * @throws {ProtocolError} `NOT_FOUND` when the agent is not the caller's or
   *   the project is not visible to them; `AGENT_DELETED` when the agent has
   *   been deleted.
   */
  addToProject(request: AgentProjectRequest): Promise<boolean>;

  /**
   * Removes one of the caller's live agents from a project and ends its
   * sessions there.
   *
   * Idempotent, like its counterpart: removing an agent from a project it is
   * not in succeeds.
   *
   * @param request - Caller, agent, project.
   * @returns What the removal did.
   * @throws {ProtocolError} `NOT_FOUND` when the agent is not the caller's;
   *   `AGENT_DELETED` when it has been deleted.
   */
  removeFromProject(request: AgentProjectRequest): Promise<AgentProjectRemoval>;
}

/**
 * Ends every session an agent holds, optionally narrowed to one project.
 *
 * `status` and `ended_at` are set together because
 * `sessions_ended_at_matches_status` requires them to agree, and sessions that
 * have already ended are excluded so a second delete cannot move an old
 * `ended_at` forward and rewrite when a listener actually stopped.
 *
 * `ended_at` is `now()` and not a `Date` this process read, which is what
 * `services/sessions.ts` writes into the same column for a heartbeat timeout or
 * an explicit stop (T-035). One column, one clock. It also still gives one
 * delete one instant, and gives it for free: `now()` is the transaction's start
 * time, so the tombstone and every session ended beside it are stamped
 * identically without anything being threaded between them.
 *
 * @param tx - The transaction to run in.
 * @param agentId - Whose sessions to end.
 * @param projectId - Narrows to one project, for a removal from that project.
 * @returns How many sessions were ended.
 */
async function endSessions(
  tx: AgentWriter,
  agentId: AgentId,
  projectId?: ProjectId,
): Promise<number> {
  const live = ne(sessions.status, 'ended');
  const scope =
    projectId === undefined
      ? and(eq(sessions.agentId, agentId), live)
      : and(eq(sessions.agentId, agentId), eq(sessions.projectId, projectId), live);

  const ended = await tx
    .update(sessions)
    .set({ status: 'ended', endedAt: sql`now()` })
    .where(scope)
    .returning({ id: sessions.id });

  return ended.length;
}

/**
 * Builds the agent lifecycle over a database handle.
 *
 * @param db - A Drizzle handle that can open transactions. `createApp` passes
 *   the process-wide one; a test may pass a handle over its own database.
 * @returns The service.
 */
export function createAgentService(db: AgentServiceDatabase): AgentService {
  /**
   * Runs `work` under an ownership assertion, in one transaction.
   *
   * The assertion is built over the transaction rather than over `db`, so the
   * agent cannot be deleted between being checked and being written to. Every
   * mutating method goes through here or through the equivalent pair in
   * {@link AgentService.addToProject}; that is what makes "call the
   * authorization service" a property of the module rather than of each
   * method's author.
   *
   * @param request - Caller and agent.
   * @param work - What to do with the validated agent.
   * @returns Whatever `work` returned.
   */
  async function withOwnedAgent<T>(
    request: DeleteAgentRequest,
    work: (tx: AgentWriter, agent: AgentRecord) => Promise<T>,
  ): Promise<T> {
    return await db.transaction(async (tx) => {
      const agent = await createAuthorizationService(tx).assertAgentOwner(request);
      return await work(tx, agent);
    });
  }

  return {
    async list(request: ListAgentsRequest): Promise<AgentRecord[]> {
      // `user_id = ? and deleted_at is null`, spelled out: exactly the
      // predicate of `agents_user_id_name_live_idx`, on its leading column, so
      // the index answers the whole query including the ordering.
      const rows = await db
        .select(AGENT_COLUMNS)
        .from(agents)
        .where(and(eq(agents.userId, request.userId), isNull(agents.deletedAt)))
        .orderBy(asc(agents.name));

      return rows.map(toAgentRecord);
    },

    async create(request: CreateAgentRequest): Promise<AgentRecord> {
      // A new identifier, every time. A tombstone with this name may exist and
      // is deliberately not looked for: reviving it would hand the caller an
      // agent that already owns a history.
      const id = AgentId.generate();

      try {
        const [row] = await db
          .insert(agents)
          .values({ id, userId: request.userId, name: request.name })
          .returning(AGENT_COLUMNS);

        if (row === undefined) {
          throw new ProtocolError(ErrorCode.INTERNAL, 'The agent insert returned no row.');
        }

        return toAgentRecord(row);
      } catch (cause: unknown) {
        if (isUniqueViolationOn(cause, LIVE_NAME_INDEX)) {
          throw new ProtocolError(ErrorCode.CONFLICT, AGENT_NAME_TAKEN_MESSAGE, { cause });
        }
        throw cause;
      }
    },

    async rename(request: RenameAgentRequest): Promise<AgentRecord> {
      return await withOwnedAgent(request, async (tx) => {
        try {
          // `deleted_at is null` again, on the write. The assertion above has
          // already established it; this is the statement's own guard against a
          // delete that commits in between, and it keeps the partial index
          // serving the lookup.
          const [row] = await tx
            .update(agents)
            .set({ name: request.name })
            .where(and(eq(agents.id, request.agentId), isNull(agents.deletedAt)))
            .returning(AGENT_COLUMNS);

          if (row === undefined) {
            throw new ProtocolError(ErrorCode.AGENT_DELETED, AGENT_ALREADY_DELETED_MESSAGE);
          }

          return toAgentRecord(row);
        } catch (cause: unknown) {
          if (isUniqueViolationOn(cause, LIVE_NAME_INDEX)) {
            throw new ProtocolError(ErrorCode.CONFLICT, AGENT_NAME_TAKEN_MESSAGE, { cause });
          }
          throw cause;
        }
      });
    },

    async delete(request: DeleteAgentRequest): Promise<AgentDeletion> {
      return await withOwnedAgent(request, async (tx) => {
        // 1. The tombstone. `deleted_at is null` in the `where` makes this the
        //    race arbiter: exactly one of two concurrent deletes updates a row,
        //    and the loser is told the agent is already gone rather than moving
        //    the timestamp.
        //
        //    `now()` and not a `Date` read here, so the tombstone comes off the
        //    same clock as the `created_at` and `updated_at` beside it in the
        //    row (T-035); read back rather than assumed, because the value is
        //    the database's to decide. It is the transaction's start time, so
        //    all three writes below share one instant and the delete still
        //    reads as one event.
        const [tombstoned] = await tx
          .update(agents)
          .set({ deletedAt: sql`now()` })
          .where(and(eq(agents.id, request.agentId), isNull(agents.deletedAt)))
          .returning({ id: agents.id, deletedAt: agents.deletedAt });

        if (tombstoned === undefined || tombstoned.deletedAt === null) {
          throw new ProtocolError(ErrorCode.AGENT_DELETED, AGENT_ALREADY_DELETED_MESSAGE);
        }

        // 2. Participation. Removed rather than tombstoned, per Plan §2 — see
        //    `db/schema/agents.ts` for why the two tables are treated
        //    differently. This is the write that makes the agent unaddressable
        //    and absent from discovery; leaving it out is the zombie.
        const left = await tx
          .delete(agentProjects)
          .where(eq(agentProjects.agentId, request.agentId))
          .returning({ projectId: agentProjects.projectId });

        // 3. Sessions. A listener holding one is subscribed on behalf of an
        //    agent that is no longer in the project.
        const sessionsEnded = await endSessions(tx, request.agentId);

        return {
          agentId: request.agentId,
          deletedAt: tombstoned.deletedAt,
          projectsLeft: left.length,
          sessionsEnded,
        };
      });
    },

    async addToProject(request: AgentProjectRequest): Promise<boolean> {
      return await db.transaction(async (tx) => {
        const authorization = createAuthorizationService(tx);

        // Two rules, two calls. Owning the agent is not enough: that would let
        // anyone add their agent to any project whose id they had seen, and
        // project ids travel in URLs and in a committed config file (D12).
        // Membership is asserted first, so a stranger is answered `NOT_FOUND`
        // about the project without learning anything about the agent.
        await authorization.assertProjectMember({
          userId: request.userId,
          projectId: request.projectId,
        });
        await authorization.assertAgentOwner(request);

        const added = await tx
          .insert(agentProjects)
          .values({ agentId: request.agentId, projectId: request.projectId })
          .onConflictDoNothing()
          .returning({ projectId: agentProjects.projectId });

        return added.length > 0;
      });
    },

    async removeFromProject(request: AgentProjectRequest): Promise<AgentProjectRemoval> {
      // Ownership only, and deliberately not membership of the project.
      //
      // Removal withdraws a capability rather than granting one, and the agent
      // is the caller's own, so nobody else can be affected by it. Requiring
      // membership would mean a user who has left a project can never withdraw
      // the agent they left behind in it, and a capability that cannot be
      // revoked is the worse failure. Nothing is disclosed either: the route is
      // idempotent, so a project the agent is not in answers exactly as one it
      // never joined.
      return await withOwnedAgent(request, async (tx) => {
        const removed = await tx
          .delete(agentProjects)
          .where(
            and(
              eq(agentProjects.agentId, request.agentId),
              eq(agentProjects.projectId, request.projectId),
            ),
          )
          .returning({ projectId: agentProjects.projectId });

        // The sessions go with the participation, for the same reason they go
        // with a delete: a session is a subscription to one project and the
        // agent is no longer in it. Narrowed to this project — the agent's
        // listeners elsewhere are unaffected.
        const sessionsEnded = await endSessions(tx, request.agentId, request.projectId);

        return { removed: removed.length > 0, sessionsEnded };
      });
    },
  };
}
