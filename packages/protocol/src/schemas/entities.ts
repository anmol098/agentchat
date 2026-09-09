/**
 * The resource representations the M1 endpoints return: users, projects, and
 * agents.
 *
 * Plan §3 names these ("→ `{ project, invitedBy }`", "→ `[{ agent, owner,
 * online, sessions: n }]`") without spelling them out, so this module is where
 * their wire shape is fixed. Two rules shaped every decision below.
 *
 * ## A representation is not a table row
 *
 * Plan §2 describes storage. What a caller may *see* is a smaller set:
 *
 * - `users.github_id` is absent. D4 keeps the protocol identity-provider
 *   agnostic, and a GitHub numeric id is an implementation detail of the
 *   reference deployment's IdP that no client has any use for.
 * - `agents.deleted_at` is absent. Soft deletion (D13) is how the server keeps
 *   historical messages resolvable; what a client needs is the
 *   `AGENT_DELETED` error code when it uses a stale id, which it already has.
 *   Deleted agents never appear in a listing.
 * - `agents.user_id` is present, so a caller can tell its own agents from
 *   another member's without a second lookup.
 *
 * ## Two views of a user
 *
 * {@link UserSchema} is what the caller may see about *themselves*, and
 * includes `email`. {@link UserSummarySchema} is what any project member or
 * invitee may see about *someone else*, and does not. `GET /invites/:code` is
 * answered to a caller who is not yet a member of anything, so leaking a
 * contact address there would be a privacy bug that no authorization check
 * later in the stack could undo.
 *
 * @module
 */

import { z } from 'zod';

import { AgentId, ProjectId, UserId } from '../ids.js';
import {
  AgentNameSchema,
  CountSchema,
  DisplayNameSchema,
  ProjectNameSchema,
  ProjectSlugSchema,
  TimestampSchema,
  UsernameSchema,
} from './primitives.js';
import { MAX_RUNTIME_LENGTH } from './sessions.js';

/**
 * A member's role in a project.
 *
 * Two values, and the difference is narrow: D11 lets *any* member create
 * invites, so `owner` gates only renaming and deleting the project itself.
 */
export const ProjectRoleSchema = z.enum(['owner', 'member']);

/** A member's role in a project: `owner` or `member`. */
export type ProjectRole = z.infer<typeof ProjectRoleSchema>;

/**
 * Every project role, in the order the schema declares them.
 *
 * For exhaustiveness tests and for rendering a role picker, not for deriving
 * privilege: `owner` sorting first is alphabetical coincidence.
 */
export const PROJECT_ROLES: readonly ProjectRole[] = Object.freeze(ProjectRoleSchema.options);

/**
 * What one user may see about another: enough to render `@alice/backend` and
 * `Invited by: Alice`, and nothing more.
 *
 * Used for the `owner` of a discovered agent and the `invitedBy` on an invite
 * preview. See the module note for why `email` is not here.
 */
export const UserSummarySchema = z.object({
  /** The user's stable identifier. */
  id: UserId.schema,
  /** Lowercase login name; the `alice` in `@alice/backend`. */
  username: UsernameSchema,
  /** Human-readable name, for display only. Never used for addressing. */
  displayName: DisplayNameSchema,
});

/** What one user may see about another. */
export type UserSummary = z.infer<typeof UserSummarySchema>;

/**
 * The authenticated caller's own account, as returned by `GET /me` and
 * alongside the tokens minted by `POST /auth/device/poll`.
 *
 * A superset of {@link UserSummarySchema}. Only ever sent to the user it
 * describes.
 */
export const UserSchema = UserSummarySchema.extend({
  /**
   * Contact address from the identity provider, or `null` when it did not
   * supply one — a GitHub account with a private email is the common case.
   *
   * Explicitly `null` rather than absent: a key that is sometimes missing and
   * sometimes null is two shapes for one fact, and every consumer then has to
   * handle both.
   */
  email: z.email().nullable(),
  /** When the account was first seen. */
  createdAt: TimestampSchema,
});

/** The authenticated caller's own account. */
export type User = z.infer<typeof UserSchema>;

/**
 * A project, as seen by someone who is not necessarily a member.
 *
 * This is the shape embedded in an invite preview, so it must be safe to show
 * to a stranger holding a valid code: a name, a slug, and who created it.
 * Membership, agents, and message counts are not here.
 */
export const ProjectSchema = z.object({
  /** The project's stable identifier; what `.agentchat/config.json` stores. */
  id: ProjectId.schema,
  /** Unique, human-typable handle for the project. */
  slug: ProjectSlugSchema,
  /** Human-readable name, for display. */
  name: ProjectNameSchema,
  /** The user who created the project. Not necessarily still a member. */
  createdBy: UserId.schema,
  /** When the project was created. */
  createdAt: TimestampSchema,
});

/** A project, as seen by someone who is not necessarily a member. */
export type Project = z.infer<typeof ProjectSchema>;

/**
 * A project together with the calling user's role in it.
 *
 * Returned wherever the caller is known to be a member — the project list, a
 * single project, and the result of joining — because the CLI has to know
 * before it offers an owner-only action whether the server will accept it. It
 * is a separate schema from {@link ProjectSchema} rather than an optional field
 * on it precisely so that the one endpoint answering a non-member (the invite
 * preview) cannot accidentally acquire a `role` that means nothing.
 */
export const ProjectMembershipSchema = ProjectSchema.extend({
  /** The calling user's role in this project. */
  role: ProjectRoleSchema,
});

/** A project together with the calling user's role in it. */
export type ProjectMembership = z.infer<typeof ProjectMembershipSchema>;

/**
 * An agent: a named participant owned by one user.
 *
 * Project membership is not part of this shape. An agent belongs to a user and
 * *joins* projects (`agent_projects`), so which projects it is in depends on
 * who is asking; the endpoints that need to answer that say so themselves.
 *
 * See the module note for why `deletedAt` is absent.
 */
export const AgentSchema = z.object({
  /** The agent's stable identifier. */
  id: AgentId.schema,
  /** The owning user. Only this user may rename or delete the agent. */
  userId: UserId.schema,
  /** Unique per owner among their live agents; the `backend` in `@alice/backend`. */
  name: AgentNameSchema,
  /** When the agent was created. */
  createdAt: TimestampSchema,
  /** When the agent was last renamed; equal to `createdAt` if never. */
  updatedAt: TimestampSchema,
});

/** An agent: a named participant owned by one user. */
export type Agent = z.infer<typeof AgentSchema>;

/**
 * One row of project agent discovery (PRD §21): who else is here, and are they
 * listening?
 *
 * `online` is derived, not stored — plan §2 defines presence as "the agent has
 * at least one `active` session in this project" — and `sessions` is the count
 * behind it, which is what makes two listeners on two machines visible as two.
 * The invariant `online === (sessions > 0)` holds, and `sessions` is kept
 * because "online" alone cannot tell a user that the listener they thought they
 * killed is still running.
 *
 * ## Why `runtimes` sits out here rather than inside `agent`
 *
 * PRD §3.4 is explicit that the runtime is metadata and "must not become the
 * agent identity", and §44 that an agent survives changing it. Nesting it under
 * {@link AgentSchema} would say the opposite — that `backend` is partly a Codex
 * thing — and it would be a lie about lifetime too: the same agent is a
 * different runtime tomorrow, and none at all the moment its listeners stop.
 * Out here it is what it actually is: a property of the sessions behind
 * `online`, in the same group of derived presence facts as `sessions`.
 */
export const ProjectAgentSchema = z.object({
  /** The agent itself. Never a deleted one (D13). */
  agent: AgentSchema,
  /** The agent's owner, as much of them as a fellow member may see. */
  owner: UserSummarySchema,
  /** Whether the agent has at least one active session in this project. */
  online: z.boolean(),
  /** How many active sessions the agent has in this project. */
  sessions: CountSchema,
  /**
   * The distinct harnesses running the agent's active sessions in this project
   * (PRD §21 "optional runtime metadata"): `['claude-code']`, or
   * `['claude-code', 'codex']` for someone listening from two.
   *
   * Three things it deliberately is not.
   *
   * It is not per session, so it does not say *which* of two listeners is
   * Codex, and it is shorter than `sessions` whenever one person runs two of
   * the same harness. Discovery answers "who is here and what is running them";
   * a session-by-session breakdown is a different question, and `GET /sessions`
   * — which only ever answers about the caller's own — is where it belongs.
   *
   * It carries no machine names. Presence is about reachability, and a hostname
   * is not: it would be the first thing here that tells one member which host
   * another member's agent runs on, and PRD §21 does not list it.
   *
   * It is not interpreted. The server stores whatever `listen --runtime` was
   * given (D14) and hands it back verbatim, so an unfamiliar name is a harness
   * this build has never heard of rather than an error. Render it; do not
   * branch on it.
   *
   * Empty for an offline agent, and empty as well for an agent whose sessions
   * predate `--runtime` being required and left the column null — the absence
   * of a claim, not a claim of absence.
   *
   * Defaulted rather than required so that the addition stays additive under
   * §12.4: a peer that legitimately omits the key is still accepted, and every
   * parse still yields an array, so no consumer has to handle a key that is
   * sometimes missing and sometimes empty.
   */
  runtimes: z.array(z.string().min(1).max(MAX_RUNTIME_LENGTH)).default([]),
});

/** One row of project agent discovery: an agent, its owner, and its presence. */
export type ProjectAgent = z.infer<typeof ProjectAgentSchema>;
