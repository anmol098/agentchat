/**
 * Every access rule in the product, in one place.
 *
 * `plugins/auth.ts` answers *who is calling*. This module answers *may they*.
 * A route handler asks one of the assertions below and either receives the row
 * it validated or does not continue; it never assembles a rule out of its own
 * `select`s. The point is auditability: PRD §31 states four boundaries — a user
 * may access projects they belong to, operate their own agents, send according
 * to project permissions, and receive on agents they are authorized for — and
 * this file is where somebody checks that the code says the same thing.
 *
 * ## The permission matrix
 *
 * | Rule                                | Who passes                                              | Assertion                     |
 * | ----------------------------------- | ------------------------------------------------------- | ----------------------------- |
 * | Read a project, list its agents, create an invite (D11) | any member                           | {@link AuthorizationService.assertProjectMember} |
 * | Rename or delete a project (D11)    | owners only                                             | {@link AuthorizationService.assertProjectOwner} |
 * | Rename or delete an agent           | the agent's owner, agent live                           | {@link AuthorizationService.assertAgentOwner} |
 * | Address an agent inside a project   | any project member, agent live and participating        | {@link AuthorizationService.assertAgentInProject} |
 * | Act *as* an agent inside a project  | the owner, in the project, agent live and participating  | {@link AuthorizationService.assertOwnAgentInProject} |
 * | Leave a project                     | any member who is not the last owner                    | {@link AuthorizationService.assertCanLeaveProject} |
 * | Read a message (D15)                | the owner of its sender or of its recipient             | {@link messageVisibleToCaller} |
 * | Read a conversation (D15)           | a project member with at least one readable message in it | {@link AuthorizationService.assertConversationParticipant} |
 *
 * ## D15 is a predicate as well as an assertion
 *
 * Every other rule here answers one question about one row, so an assertion is
 * the whole of it. The read rule is not like that: `GET /conversations/:id`
 * returns a *page* of messages and the question has to be asked of every row on
 * it, inside the `WHERE`. Selecting a page and filtering it afterwards would be
 * both a disclosure waiting for someone to forget the filter and a limit that
 * quietly returns fewer rows than it promised.
 *
 * So D15 is written once, as {@link messageVisibleToCaller}, and used twice:
 * {@link AuthorizationService.assertConversationParticipant} asks whether *any*
 * message in a thread satisfies it, and `services/conversations.ts` puts the
 * same expression into the `WHERE` of the page it reads. Neither of them
 * restates the rule. `services/messages.ts` carries an older copy of the same
 * predicate for the threading lookups it makes inside its own transaction; that
 * file belongs to T-303 and was deliberately not edited here, so collapsing the
 * two is a follow-up rather than something this task did in passing.
 *
 * A send is the composite the plan spells out (§2): the caller must be a member
 * of the project, the sender agent must pass `assertOwnAgentInProject`, and the
 * recipient agent must pass `assertAgentInProject`. Three calls, because they
 * are three different rules with three different remedies — not one call with a
 * flag.
 *
 * ## Which failures admit that a resource exists
 *
 * `FORBIDDEN` is an admission. "You may not rename this project" says the
 * project is there. That is the right thing to say to somebody who already
 * knows — a member — and the wrong thing to say to somebody who does not, which
 * is why the choice is made per rule rather than once:
 *
 * - **Not a member of a project → {@link ErrorCode.NOT_FOUND}.** A project is
 *   invisible outside its membership, so "no such project" and "you are not in
 *   it" must be one answer. `FORBIDDEN` here would turn `GET /projects/:id` into
 *   an oracle that confirms an id, and project ids appear in URLs, shell
 *   history, and the committed `.agentchat/config.json` (D12).
 * - **A member, but the rule wants an owner → {@link ErrorCode.FORBIDDEN}.** The
 *   caller is already inside the boundary and can see the project by other
 *   means; withholding the reason would only send them to look for a bug. The
 *   remedy — ask an owner — is real and only `FORBIDDEN` conveys it.
 * - **Not the owner of an agent → {@link ErrorCode.NOT_FOUND},** identically to
 *   an agent that never existed. Ownership *is* the visibility boundary for the
 *   agent-management routes; there is no wider audience to whom the agent is
 *   already visible.
 * - **Your own agent, soft-deleted → {@link ErrorCode.AGENT_DELETED}.** The
 *   caller demonstrably owned it, so nothing is disclosed, and the remedy
 *   differs from a 404: their cached id is stale, not wrong.
 * - **Somebody else's agent, soft-deleted → {@link ErrorCode.NOT_FOUND}.**
 *   Deleting an agent removes its `agent_projects` rows (Plan §2, D13), so
 *   after the fact the server *cannot establish* that this caller was ever
 *   entitled to know the agent existed. When visibility cannot be established
 *   it is not asserted. Nothing is lost: the CLI's remedy for both answers is
 *   to resolve the address again.
 * - **An agent that is live but not in the project →
 *   {@link ErrorCode.AGENT_NOT_IN_PROJECT}, but only when the caller could
 *   already have seen it** — it is the caller's own agent, or its owner is a
 *   member of the same project, and co-members are visible to each other.
 *   Otherwise `NOT_FOUND`. `packages/protocol` justifies this code by the
 *   remedy it lets the CLI print (`agentchat agent join <name>`); handing that
 *   remedy to somebody who cannot act on it would buy nothing and would confirm
 *   that a stranger's agent exists.
 *
 * Every project-scoped agent assertion checks the caller's own membership
 * *first* and answers `NOT_FOUND` before reading anything out of the agent row.
 * That check is inside the same query rather than a precondition on the caller,
 * because a precondition is a rule a future route can forget.
 *
 * One message per code, taken from a frozen table that the cause is not passed
 * to. Two different reasons for a `NOT_FOUND` are therefore byte-identical by
 * construction, not by everyone remembering. The reason travels in the error's
 * `cause`, which `errors.ts` logs and never sends.
 *
 * ## Shape of the queries
 *
 * One round trip per assertion. The agent rules need four facts — the agent
 * row, whether the caller is in the project, whether the agent is in the
 * project, whether the agent's owner is in the project — and they are collected
 * by joins in a single statement rather than by three sequential awaits on a
 * path that runs on every send. `assertCanLeaveProject` is the one place where
 * more than the caller's own row is read, and it is bounded to the project's
 * owners.
 *
 * Assertions return the row they validated. A route that has just proved a
 * project is visible almost always needs the project, and re-querying it would
 * be both a wasted round trip and a second chance to read it without the check.
 * Returned agent records carry no `deletedAt`, because a returned agent is live
 * by construction.
 *
 * ## Transactions
 *
 * {@link createAuthorizationService} takes any Drizzle handle, including a
 * transaction, so a route that must not race between the check and the write
 * builds a service over its own transaction. `assertCanLeaveProject` is the
 * assertion that needs it: two owners leaving concurrently can each observe two
 * owners. Outside a transaction that is a real, if narrow, race; the fix
 * belongs to the writer that owns the transaction, and this module makes it
 * expressible rather than pretending to solve it with a lock it would drop
 * immediately.
 *
 * @module
 */

import {
  AgentId,
  ConversationId,
  ErrorCode,
  ProjectId,
  ProtocolError,
  UserId,
} from '@stackgrid/protocol';
import { and, eq, or, type SQL, sql } from 'drizzle-orm';
import { alias, type PgDatabase, type PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects } from '../db/schema/identity.js';
import { conversations, messages } from '../db/schema/messaging.js';

// ---------------------------------------------------------------------------
// Values a caller receives
// ---------------------------------------------------------------------------

/**
 * A member's standing in a project.
 *
 * The two values `project_members_role_valid` permits. Owners may rename or
 * delete the project; every member may do everything else (D11).
 */
export type ProjectRole = 'owner' | 'member';

/** A project, as an authorized caller sees it. */
export interface ProjectRecord {
  /** `prj_` identifier. */
  readonly id: ProjectId;
  /** URL-safe short name, unique across the server. */
  readonly slug: string;
  /** Display name. */
  readonly name: string;
  /** The member who created it. */
  readonly createdBy: UserId;
  /** When it was created. */
  readonly createdAt: Date;
}

/**
 * The result of a project assertion: the project, and what the caller is in it.
 *
 * Returned rather than discarded so a handler that has just proved the project
 * is visible does not immediately select it again.
 */
export interface ProjectAccess {
  /** The project the assertion validated. */
  readonly project: ProjectRecord;
  /** The caller's role in it. */
  readonly role: ProjectRole;
  /** When the caller joined. */
  readonly joinedAt: Date;
}

/**
 * A live agent, as an authorized caller sees it.
 *
 * There is no `deletedAt`: an agent that fails the liveness check never leaves
 * an assertion, so a caller holding one of these cannot forget to test it.
 */
export interface AgentRecord {
  /** `agt_` identifier. */
  readonly id: AgentId;
  /** The user who owns it. */
  readonly userId: UserId;
  /** The agent's name; the half of `@alice/backend` after the slash. */
  readonly name: string;
  /** When it was registered. */
  readonly createdAt: Date;
  /** When the row last changed. */
  readonly updatedAt: Date;
}

/**
 * A conversation the caller is party to.
 *
 * Almost empty, because the table is: a conversation is an identity to group
 * messages under and the server has no opinion about what it is about (PRD
 * §3.7). It carries its project because the caller does not name one —
 * `GET /conversations/:id` has no `projectId` — and a reader has to be told
 * which project's boundary the thread sits behind.
 */
export interface ConversationRecord {
  /** `cnv_` identifier. */
  readonly id: ConversationId;
  /** The project the thread belongs to. */
  readonly projectId: ProjectId;
  /** When the thread was opened, i.e. when its first message was sent. */
  readonly createdAt: Date;
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** The codes a project rule may answer with. */
export type ProjectFailureCode =
  | typeof ErrorCode.NOT_FOUND
  | typeof ErrorCode.FORBIDDEN
  | typeof ErrorCode.CONFLICT;

/** The codes an agent rule may answer with. */
export type AgentFailureCode =
  | typeof ErrorCode.NOT_FOUND
  | typeof ErrorCode.AGENT_DELETED
  | typeof ErrorCode.AGENT_NOT_IN_PROJECT;

/**
 * The message each project failure carries.
 *
 * Total over {@link ProjectFailureCode} so a code added to a rule cannot ship
 * without somebody writing what the caller is told. The `NOT_FOUND` wording
 * states the ambiguity instead of hiding it: pretending the project certainly
 * does not exist would be a lie to a member who mistyped their own project id.
 */
export const PROJECT_FAILURE_MESSAGES: Readonly<Record<ProjectFailureCode, string>> = Object.freeze(
  {
    [ErrorCode.NOT_FOUND]: 'No such project, or you are not a member of it.',
    [ErrorCode.FORBIDDEN]:
      'Only an owner of this project may do that. Ask an owner to make the change.',
    [ErrorCode.CONFLICT]:
      'You are the only owner of this project. Make another member an owner before you leave.',
  },
);

/** The message each agent failure carries. Total, for the same reason. */
export const AGENT_FAILURE_MESSAGES: Readonly<Record<AgentFailureCode, string>> = Object.freeze({
  [ErrorCode.NOT_FOUND]: 'No such agent, or it is not one you can use here.',
  [ErrorCode.AGENT_DELETED]:
    'That agent has been deleted. Register one with: agentchat agent create <name>',
  [ErrorCode.AGENT_NOT_IN_PROJECT]:
    'That agent is not in this project. Add it with: agentchat agent join <name>',
});

/** The one code a conversation read may be refused with. */
export type ConversationFailureCode = typeof ErrorCode.NOT_FOUND;

/**
 * The message a refused conversation read carries.
 *
 * One entry, because the rule has one answer. Three different causes —
 * no such thread, a thread in somebody else's project, a thread in this
 * caller's project that none of their agents is party to — share it byte for
 * byte, which is what stops the endpoint from confirming any of them.
 */
export const CONVERSATION_FAILURE_MESSAGES: Readonly<Record<ConversationFailureCode, string>> =
  Object.freeze({
    [ErrorCode.NOT_FOUND]: 'No such conversation, or none of your agents is party to it.',
  });

/**
 * Builds the failure a rule reports.
 *
 * The message is looked up from the code and nothing else, which is what makes
 * two different causes of one code indistinguishable on the wire without anyone
 * having to remember. `reason` is the operator's half: `errors.ts` never sends
 * a `cause`, and `app.ts` logs it with the request id.
 *
 * @param code - The contract code the caller branches on.
 * @param messages - The frozen table for this rule family.
 * @param reason - Internal detail. Never sent.
 * @returns The error to throw.
 */
function failure<TCode extends ProjectFailureCode | AgentFailureCode | ConversationFailureCode>(
  code: TCode,
  messages: Readonly<Record<TCode, string>>,
  reason: string,
): ProtocolError {
  return new ProtocolError(code, messages[code], { cause: new Error(reason) });
}

// ---------------------------------------------------------------------------
// The rules, as pure decisions
// ---------------------------------------------------------------------------

/**
 * What the database knows about a caller's standing in one project.
 *
 * `role` is `undefined` when there is no membership row — whether because the
 * project does not exist or because the caller is not in it. The two cases are
 * not distinguished here because they must not be distinguished anywhere.
 */
export interface ProjectFacts {
  /** The caller's role, or `undefined` if they have no membership row. */
  readonly role: ProjectRole | undefined;
}

/**
 * Decides a project rule.
 *
 * Split out from the query so the matrix can be tested exhaustively without a
 * database, and so the whole rule is four lines somebody can read at once.
 *
 * @param facts - What was found.
 * @param requiredRole - `'member'` for a rule any member passes, `'owner'` for
 *   an owner-only rule (D11: rename and delete).
 * @returns The failure code, or `undefined` when the caller passes.
 */
export function projectFailureCode(
  facts: ProjectFacts,
  requiredRole: ProjectRole,
): ProjectFailureCode | undefined {
  // Nothing about the project is revealed to a non-member, including whether
  // it exists.
  if (facts.role === undefined) {
    return ErrorCode.NOT_FOUND;
  }

  // A member already knows the project is there, so the honest answer is the
  // useful one.
  if (requiredRole === 'owner' && facts.role !== 'owner') {
    return ErrorCode.FORBIDDEN;
  }

  return undefined;
}

/** What the database knows about a project a member is trying to leave. */
export interface ProjectLeaveFacts extends ProjectFacts {
  /** How many owners the project has, counting the caller. */
  readonly ownerCount: number;
}

/**
 * Decides whether a member may leave.
 *
 * Leaving is not an owner-only operation and the last owner leaving is not a
 * permissions failure — it is a state the project may not be put into, so it is
 * a {@link ErrorCode.CONFLICT} rather than a `FORBIDDEN`. An ownerless project
 * can never be renamed or deleted again by anybody.
 *
 * @param facts - What was found.
 * @returns The failure code, or `undefined` when the caller may leave.
 */
export function projectLeaveFailureCode(facts: ProjectLeaveFacts): ProjectFailureCode | undefined {
  const membership = projectFailureCode(facts, 'member');
  if (membership !== undefined) {
    return membership;
  }

  return facts.role === 'owner' && facts.ownerCount <= 1 ? ErrorCode.CONFLICT : undefined;
}

/** What the database knows about an agent, independent of any project. */
export interface AgentFacts {
  /** Whether a row with this id exists at all. */
  readonly exists: boolean;
  /** Whether that row's `user_id` is the caller. */
  readonly ownedByCaller: boolean;
  /** Whether it carries a `deleted_at` (D13). */
  readonly deleted: boolean;
}

/**
 * Decides the agent-ownership rule: may this caller operate this agent?
 *
 * @param facts - What was found.
 * @returns The failure code, or `undefined` when the caller owns a live agent.
 */
export function agentOwnershipFailureCode(facts: AgentFacts): AgentFailureCode | undefined {
  // One answer for "no such row" and "somebody else's". Ownership is the
  // visibility boundary here, so a distinction would be a disclosure.
  if (!facts.exists || !facts.ownedByCaller) {
    return ErrorCode.NOT_FOUND;
  }

  // A tombstone is not an agent. The caller owned it, so they are told so.
  if (facts.deleted) {
    return ErrorCode.AGENT_DELETED;
  }

  return undefined;
}

/** What the database knows about an agent in the context of one project. */
export interface AgentInProjectFacts extends AgentFacts {
  /** Whether the caller is a member of the project. */
  readonly callerIsProjectMember: boolean;
  /** Whether the agent has an `agent_projects` row for the project. */
  readonly participates: boolean;
  /** Whether the agent's owner is a member of the project. */
  readonly ownerIsProjectMember: boolean;
}

/**
 * Decides whether an agent may be addressed inside a project.
 *
 * This is the recipient rule, and the one place where a code is chosen by what
 * the caller could already have seen. See the module note.
 *
 * @param facts - What was found.
 * @returns The failure code, or `undefined` when the agent is live and in the
 *   project and the caller may know it.
 */
export function agentInProjectFailureCode(
  facts: AgentInProjectFacts,
): AgentFailureCode | undefined {
  // Checked before anything is read out of the agent row: outside the project
  // there is no audience for any of it.
  if (!facts.callerIsProjectMember || !facts.exists) {
    return ErrorCode.NOT_FOUND;
  }

  if (facts.deleted) {
    // The tombstone kept no project links, so entitlement to know it existed
    // can only be established for its owner.
    return facts.ownedByCaller ? ErrorCode.AGENT_DELETED : ErrorCode.NOT_FOUND;
  }

  if (facts.participates) {
    return undefined;
  }

  // The actionable code, for the two audiences that could already have seen the
  // agent: its owner, and members of a project its owner is also in.
  return facts.ownedByCaller || facts.ownerIsProjectMember
    ? ErrorCode.AGENT_NOT_IN_PROJECT
    : ErrorCode.NOT_FOUND;
}

/**
 * Decides whether a caller may act *as* an agent inside a project.
 *
 * The sender rule from Plan §2: owned by the caller **and** in the project.
 * Owning an agent is not the same as that agent being in a given project, and
 * neither half implies the other, so this is deliberately one assertion rather
 * than two a route could half-apply.
 *
 * @param facts - What was found.
 * @returns The failure code, or `undefined` when the caller may act as it.
 */
export function ownAgentInProjectFailureCode(
  facts: AgentInProjectFacts,
): AgentFailureCode | undefined {
  if (!facts.callerIsProjectMember) {
    return ErrorCode.NOT_FOUND;
  }

  const ownership = agentOwnershipFailureCode(facts);
  if (ownership !== undefined) {
    return ownership;
  }

  // Reached only for the caller's own live agent, so the remedy it names is one
  // they can actually carry out.
  return facts.participates ? undefined : ErrorCode.AGENT_NOT_IN_PROJECT;
}

// ---------------------------------------------------------------------------
// The queries
// ---------------------------------------------------------------------------

/**
 * The part of a Drizzle handle this module uses.
 *
 * A `Pick` of `PgDatabase` rather than of `NodePgDatabase` so a pool handle and
 * a transaction handle — different types, parameterised by different schemas —
 * both satisfy it. Read-only by construction: an authorization check that could
 * write would be a surprising thing to find in a hot path.
 */
export type QueryRunner = Pick<PgDatabase<PgQueryResultHKT>, 'select'>;

/**
 * D15, as a `WHERE` fragment about a row of `messages`.
 *
 * "A caller may read a message when one of their own agents is its sender or
 * its recipient." The whole rule, in one expression, correlated to whatever
 * `messages` row is in scope — so it composes into a page read as well as into
 * a single-row lookup.
 *
 * It is a correlated `EXISTS` rather than a join to `agents` on purpose. The
 * join reads identically until the caller owns *both* ends of a message —
 * sending to their own second agent, which the plan permits — and then it
 * matches twice and returns the message twice. A single-row lookup with
 * `LIMIT 1` never notices; a page does, by silently spending two of its rows on
 * one message. `EXISTS` stops at the first match by construction.
 *
 * Liveness is deliberately not part of it. D15 is about ownership, and an agent
 * soft-deleted yesterday does not retract the caller's standing in a thread it
 * took part in — the history stays readable to the person whose agent was in
 * it.
 *
 * @param userId - The authenticated caller.
 * @returns A predicate for the `WHERE` of any query with `messages` in scope.
 */
export function messageVisibleToCaller(userId: UserId): SQL {
  return sql`exists (
    select 1
    from ${agents}
    where ${agents.userId} = ${userId}
      and (${agents.id} = ${messages.senderAgentId} or ${agents.id} = ${messages.recipientAgentId})
  )`;
}

/** Rows come back with `role` typed as the column's `text`. */
function parseRole(value: string): ProjectRole {
  if (value === 'owner' || value === 'member') {
    return value;
  }

  // `project_members_role_valid` makes this unreachable through this
  // application. A row can still arrive from a migration or a hand-written
  // `psql` session, and guessing which side of the owner boundary it falls on
  // is not a decision this module gets to make silently.
  throw new ProtocolError(
    ErrorCode.INTERNAL,
    `project_members.role holds an unrecognised value: ${value}`,
  );
}

/** The columns every project assertion selects. */
const PROJECT_ACCESS_COLUMNS = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  createdBy: projects.createdBy,
  createdAt: projects.createdAt,
  userId: projectMembers.userId,
  role: projectMembers.role,
  joinedAt: projectMembers.createdAt,
} as const;

/** The shape {@link PROJECT_ACCESS_COLUMNS} produces. */
interface ProjectAccessRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  readonly userId: string;
  readonly role: string;
  readonly joinedAt: Date;
}

/**
 * Turns a joined row into the value a caller receives.
 *
 * Identifiers are branded without re-parsing: they come from columns whose
 * `CHECK` constraints already pin the prefix and the UUIDv7 shape, and this is
 * the sanctioned alternative to an `as` cast.
 *
 * @param row - The row as Drizzle returned it.
 * @returns The caller's view of it.
 */
function toProjectAccess(row: ProjectAccessRow): ProjectAccess {
  return {
    project: {
      id: ProjectId.unsafeCast(row.id),
      slug: row.slug,
      name: row.name,
      createdBy: UserId.unsafeCast(row.createdBy),
      createdAt: row.createdAt,
    },
    role: parseRole(row.role),
    joinedAt: row.joinedAt,
  };
}

/** The columns every agent assertion selects. */
const AGENT_COLUMNS = {
  id: agents.id,
  userId: agents.userId,
  name: agents.name,
  createdAt: agents.createdAt,
  updatedAt: agents.updatedAt,
  deletedAt: agents.deletedAt,
} as const;

/** The shape {@link AGENT_COLUMNS} produces. */
interface AgentRow {
  readonly id: string;
  readonly userId: string;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly deletedAt: Date | null;
}

/**
 * Turns an agent row into the value a caller receives.
 *
 * @param row - The row as Drizzle returned it. Already known to be live.
 * @returns The caller's view of it, without the tombstone column.
 */
function toAgentRecord(row: AgentRow): AgentRecord {
  return {
    id: AgentId.unsafeCast(row.id),
    userId: UserId.unsafeCast(row.userId),
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** Who is asking, about which project. */
export interface ProjectRequest {
  /** The authenticated caller, from `request.requireUser()`. */
  readonly userId: UserId;
  /** The project the route names. */
  readonly projectId: ProjectId;
}

/** Who is asking, about which agent. */
export interface AgentRequest {
  /** The authenticated caller. */
  readonly userId: UserId;
  /** The agent the route names. */
  readonly agentId: AgentId;
}

/** Who is asking, about which agent, in which project. */
export interface AgentInProjectRequest extends AgentRequest, ProjectRequest {}

/**
 * Who is asking, about which conversation.
 *
 * No `projectId`: a conversation names its own project and `GET
 * /conversations/:id` does not carry one, so taking one here would let a caller
 * ask about a thread under the wrong boundary and be told something about the
 * mismatch.
 */
export interface ConversationRequest {
  /** The authenticated caller. */
  readonly userId: UserId;
  /** The conversation the route names. */
  readonly conversationId: ConversationId;
}

/**
 * The access rules, bound to a database handle.
 *
 * Every method either returns the row it validated or throws a
 * {@link ProtocolError} carrying a contract code. None of them return a
 * boolean: a rule that can be evaluated and ignored is a rule that will be.
 */
export interface AuthorizationService {
  /**
   * Asserts the caller is a member of the project.
   *
   * The rule behind reading a project, listing its agents, and creating an
   * invite — D11 gives invite creation to any member, deliberately.
   *
   * @param request - Caller and project.
   * @returns The project and the caller's role in it.
   * @throws {ProtocolError} `NOT_FOUND` when the project does not exist or the
   *   caller is not in it. The two are one answer.
   */
  assertProjectMember(request: ProjectRequest): Promise<ProjectAccess>;

  /**
   * Asserts the caller owns the project.
   *
   * The rule behind renaming and deleting a project (D11).
   *
   * @param request - Caller and project.
   * @returns The project and the caller's role, which is always `'owner'`.
   * @throws {ProtocolError} `NOT_FOUND` when the caller is not a member;
   *   `FORBIDDEN` when they are a member but not an owner.
   */
  assertProjectOwner(request: ProjectRequest): Promise<ProjectAccess>;

  /**
   * Asserts the caller may leave the project.
   *
   * @param request - Caller and project.
   * @returns The project and the caller's role.
   * @throws {ProtocolError} `NOT_FOUND` when the caller is not a member;
   *   `CONFLICT` when they are its only owner.
   */
  assertCanLeaveProject(request: ProjectRequest): Promise<ProjectAccess>;

  /**
   * Asserts the caller owns the agent and it is live.
   *
   * The rule behind renaming, deleting, and joining an agent to a project.
   *
   * @param request - Caller and agent.
   * @returns The agent. Live by construction.
   * @throws {ProtocolError} `NOT_FOUND` when no such agent exists or it belongs
   *   to somebody else; `AGENT_DELETED` when the caller's own agent has been
   *   soft-deleted.
   */
  assertAgentOwner(request: AgentRequest): Promise<AgentRecord>;

  /**
   * Asserts an agent is live and participates in the project, and that the
   * caller may know about it.
   *
   * The recipient rule. It does **not** assert ownership: a recipient is
   * usually somebody else's agent. Use {@link assertOwnAgentInProject} for a
   * sender.
   *
   * @param request - Caller, agent, project.
   * @returns The agent. Live and participating by construction.
   * @throws {ProtocolError} `NOT_FOUND` when the caller is not in the project,
   *   the agent does not exist, or the caller could not have seen it;
   *   `AGENT_DELETED` for the caller's own soft-deleted agent;
   *   `AGENT_NOT_IN_PROJECT` when the agent is live, outside the project, and
   *   already visible to the caller.
   */
  assertAgentInProject(request: AgentInProjectRequest): Promise<AgentRecord>;

  /**
   * Asserts the caller owns a live agent that participates in the project.
   *
   * The sender rule from Plan §2. Both halves in one call because a route needs
   * both and applying one is not obviously wrong in review.
   *
   * @param request - Caller, agent, project.
   * @returns The agent. Owned, live and participating by construction.
   * @throws {ProtocolError} `NOT_FOUND` when the caller is not in the project,
   *   or the agent does not exist or is not theirs; `AGENT_DELETED` when it is
   *   soft-deleted; `AGENT_NOT_IN_PROJECT` when it is live but not in the
   *   project.
   */
  assertOwnAgentInProject(request: AgentInProjectRequest): Promise<AgentRecord>;

  /**
   * Asserts the caller may read a conversation (D15).
   *
   * Two conditions, and both are needed:
   *
   * - **A member of the conversation's project.** A project is invisible
   *   outside its membership, and a thread inside one does not get to be more
   *   visible than the project that contains it. It also settles what happens
   *   to somebody who leaves: `services/projects.ts` removes their agents from
   *   the project as they go, so without this half a departed member would keep
   *   reading threads in a project they can no longer see.
   * - **At least one message in the thread that {@link messageVisibleToCaller}
   *   admits.** This is D15 itself. Project membership alone is emphatically
   *   not enough: two agents' conversation is not readable by everybody else in
   *   the project, which is the property the integration suite is built around.
   *
   * Passing does **not** mean the whole thread is readable. The caller sees the
   * messages their own agents sent or received and no others, so
   * `services/conversations.ts` applies the same predicate to every row of the
   * page. This assertion answers "is there a thread here for you at all", which
   * is the question that decides between a page and a 404.
   *
   * @param request - Caller and conversation.
   * @returns The conversation, with the project it belongs to.
   * @throws {ProtocolError} `NOT_FOUND` when the conversation does not exist,
   *   is in a project the caller is not in, or holds nothing the caller may
   *   read. One answer for all three, deliberately: a `cnv_` id is otherwise
   *   only ever seen by the parties to the thread, so distinguishing them would
   *   turn this route into an oracle that confirms a guessed id — and confirms
   *   to a project member that two of their colleagues are talking.
   */
  assertConversationParticipant(request: ConversationRequest): Promise<ConversationRecord>;
}

/**
 * Reads the caller's membership row and the project in one statement.
 *
 * Driven from `project_members` rather than from `projects` with a left join,
 * so the query is structurally incapable of returning a project the caller is
 * not in. The check is in the SQL, not in an `if` after it.
 *
 * @param runner - Database or transaction handle.
 * @param request - Caller and project.
 * @returns The joined row, or `undefined` when there is no membership.
 */
async function selectProjectAccess(
  runner: QueryRunner,
  request: ProjectRequest,
): Promise<ProjectAccessRow | undefined> {
  const rows = await runner
    .select(PROJECT_ACCESS_COLUMNS)
    .from(projectMembers)
    .innerJoin(projects, eq(projects.id, projectMembers.projectId))
    .where(
      and(
        eq(projectMembers.projectId, request.projectId),
        eq(projectMembers.userId, request.userId),
      ),
    )
    .limit(1);

  return rows[0];
}

/**
 * The facts an agent rule needs, in one statement.
 *
 * Four questions, four joins, one round trip: this runs on every send. The two
 * membership joins are aliases of the same table asked about different people —
 * the caller, so a non-member is refused before anything is read out of the
 * agent row, and the agent's owner, so the not-in-project code is only offered
 * to somebody who could already have seen the agent.
 *
 * @param runner - Database or transaction handle.
 * @param request - Caller, agent, project.
 * @returns The agent row when one exists, and the three membership facts.
 */
async function selectAgentInProject(
  runner: QueryRunner,
  request: AgentInProjectRequest,
): Promise<{ row: AgentRow | undefined; facts: AgentInProjectFacts }> {
  const callerMembership = alias(projectMembers, 'caller_membership');
  const ownerMembership = alias(projectMembers, 'owner_membership');

  const rows = await runner
    .select({
      ...AGENT_COLUMNS,
      participation: agentProjects.agentId,
      callerMembership: callerMembership.userId,
      ownerMembership: ownerMembership.userId,
    })
    .from(agents)
    .leftJoin(
      agentProjects,
      and(eq(agentProjects.agentId, agents.id), eq(agentProjects.projectId, request.projectId)),
    )
    .leftJoin(
      callerMembership,
      and(
        eq(callerMembership.projectId, request.projectId),
        eq(callerMembership.userId, request.userId),
      ),
    )
    .leftJoin(
      ownerMembership,
      and(
        eq(ownerMembership.projectId, request.projectId),
        eq(ownerMembership.userId, agents.userId),
      ),
    )
    .where(eq(agents.id, request.agentId))
    .limit(1);

  const row = rows[0];

  if (row === undefined) {
    // No agent row means no join results either, so the caller's membership is
    // unknown here. Both unknowns answer NOT_FOUND, so nothing is lost by not
    // asking again — and asking again would be a second round trip spent
    // refining an answer that must stay coarse.
    return {
      row: undefined,
      facts: {
        exists: false,
        ownedByCaller: false,
        deleted: false,
        callerIsProjectMember: false,
        participates: false,
        ownerIsProjectMember: false,
      },
    };
  }

  return {
    row,
    facts: {
      exists: true,
      ownedByCaller: row.userId === request.userId,
      deleted: row.deletedAt !== null,
      callerIsProjectMember: row.callerMembership !== null,
      participates: row.participation !== null,
      ownerIsProjectMember: row.ownerMembership !== null,
    },
  };
}

/**
 * Reads a conversation the caller may see, in one statement.
 *
 * Driven from `conversations` and narrowed by two things that are both in the
 * `WHERE`: an inner join to the caller's own membership row, so the query
 * cannot structurally return a thread from a project they are not in, and a
 * correlated `EXISTS` over the thread's messages carrying
 * {@link messageVisibleToCaller}. The `EXISTS` stops at the first readable
 * message — it rides `messages_conversation_id_created_at_idx` and does not
 * read the thread — so the cost of the check does not grow with the length of
 * the conversation it guards.
 *
 * @param runner - Database or transaction handle.
 * @param request - Caller and conversation.
 * @returns The row, or `undefined` when there is nothing the caller may see.
 */
async function selectVisibleConversation(
  runner: QueryRunner,
  request: ConversationRequest,
): Promise<{ id: string; projectId: string; createdAt: Date } | undefined> {
  const rows = await runner
    .select({
      id: conversations.id,
      projectId: conversations.projectId,
      createdAt: conversations.createdAt,
    })
    .from(conversations)
    .innerJoin(
      projectMembers,
      and(
        eq(projectMembers.projectId, conversations.projectId),
        eq(projectMembers.userId, request.userId),
      ),
    )
    .where(
      and(
        eq(conversations.id, request.conversationId),
        sql`exists (
          select 1
          from ${messages}
          where ${messages.conversationId} = ${conversations.id}
            and ${messageVisibleToCaller(request.userId)}
        )`,
      ),
    )
    .limit(1);

  return rows[0];
}

/**
 * Builds the access rules over a database handle.
 *
 * @param runner - A Drizzle database or transaction. Pass a transaction when
 *   the check and the write that depends on it must not race.
 * @returns The service.
 */
export function createAuthorizationService(runner: QueryRunner): AuthorizationService {
  /**
   * Runs a project rule.
   *
   * @param request - Caller and project.
   * @param requiredRole - What the rule demands.
   * @returns The validated access.
   */
  async function requireProjectRole(
    request: ProjectRequest,
    requiredRole: ProjectRole,
  ): Promise<ProjectAccess> {
    const row = await selectProjectAccess(runner, request);
    const access = row === undefined ? undefined : toProjectAccess(row);
    const code = projectFailureCode({ role: access?.role }, requiredRole);

    if (code !== undefined) {
      throw failure(
        code,
        PROJECT_FAILURE_MESSAGES,
        `user ${request.userId} failed the ${requiredRole} rule on project ${request.projectId}`,
      );
    }

    // `code === undefined` is only reachable when a membership row was found.
    if (access === undefined) {
      throw new ProtocolError(ErrorCode.INTERNAL, 'project rule passed without a membership row.');
    }

    return access;
  }

  /**
   * Runs an agent rule that is scoped to a project.
   *
   * @param request - Caller, agent, project.
   * @param decide - The rule.
   * @param ruleName - Names the rule in the operator-facing reason.
   * @returns The validated agent.
   */
  async function requireAgentInProject(
    request: AgentInProjectRequest,
    decide: (facts: AgentInProjectFacts) => AgentFailureCode | undefined,
    ruleName: string,
  ): Promise<AgentRecord> {
    const { row, facts } = await selectAgentInProject(runner, request);
    const code = decide(facts);

    if (code !== undefined) {
      throw failure(
        code,
        AGENT_FAILURE_MESSAGES,
        `user ${request.userId} failed the ${ruleName} rule on agent ${request.agentId} ` +
          `in project ${request.projectId}`,
      );
    }

    if (row === undefined) {
      throw new ProtocolError(ErrorCode.INTERNAL, `${ruleName} rule passed without an agent row.`);
    }

    return toAgentRecord(row);
  }

  return {
    assertProjectMember(request: ProjectRequest): Promise<ProjectAccess> {
      return requireProjectRole(request, 'member');
    },

    assertProjectOwner(request: ProjectRequest): Promise<ProjectAccess> {
      return requireProjectRole(request, 'owner');
    },

    async assertCanLeaveProject(request: ProjectRequest): Promise<ProjectAccess> {
      // The caller's row and every owner's row, and no more: enough to count
      // owners without reading a member list whose size nobody bounds.
      const rows = await runner
        .select(PROJECT_ACCESS_COLUMNS)
        .from(projectMembers)
        .innerJoin(projects, eq(projects.id, projectMembers.projectId))
        .where(
          and(
            eq(projectMembers.projectId, request.projectId),
            or(eq(projectMembers.role, 'owner'), eq(projectMembers.userId, request.userId)),
          ),
        );

      const callerRow = rows.find((row) => row.userId === request.userId);
      const access = callerRow === undefined ? undefined : toProjectAccess(callerRow);
      const ownerCount = rows.filter((row) => row.role === 'owner').length;

      const code = projectLeaveFailureCode({ role: access?.role, ownerCount });
      if (code !== undefined) {
        throw failure(
          code,
          PROJECT_FAILURE_MESSAGES,
          `user ${request.userId} may not leave project ${request.projectId}`,
        );
      }

      if (access === undefined) {
        throw new ProtocolError(ErrorCode.INTERNAL, 'leave rule passed without a membership row.');
      }

      return access;
    },

    async assertAgentOwner(request: AgentRequest): Promise<AgentRecord> {
      const rows = await runner
        .select(AGENT_COLUMNS)
        .from(agents)
        .where(eq(agents.id, request.agentId))
        .limit(1);

      const row = rows[0];
      const code = agentOwnershipFailureCode({
        exists: row !== undefined,
        ownedByCaller: row?.userId === request.userId,
        deleted: row?.deletedAt != null,
      });

      if (code !== undefined) {
        throw failure(
          code,
          AGENT_FAILURE_MESSAGES,
          `user ${request.userId} failed the ownership rule on agent ${request.agentId}`,
        );
      }

      if (row === undefined) {
        throw new ProtocolError(ErrorCode.INTERNAL, 'ownership rule passed without an agent row.');
      }

      return toAgentRecord(row);
    },

    assertAgentInProject(request: AgentInProjectRequest): Promise<AgentRecord> {
      return requireAgentInProject(request, agentInProjectFailureCode, 'participation');
    },

    assertOwnAgentInProject(request: AgentInProjectRequest): Promise<AgentRecord> {
      return requireAgentInProject(request, ownAgentInProjectFailureCode, 'own-participation');
    },

    async assertConversationParticipant(request: ConversationRequest): Promise<ConversationRecord> {
      const row = await selectVisibleConversation(runner, request);

      if (row === undefined) {
        throw failure(
          ErrorCode.NOT_FOUND,
          CONVERSATION_FAILURE_MESSAGES,
          `user ${request.userId} failed the read rule on conversation ${request.conversationId}`,
        );
      }

      return {
        id: ConversationId.unsafeCast(row.id),
        projectId: ProjectId.unsafeCast(row.projectId),
        createdAt: row.createdAt,
      };
    },
  };
}
