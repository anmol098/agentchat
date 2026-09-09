/**
 * Invite endpoints: minting a code, previewing what it opens, and redeeming it
 * (plan §3 "Projects", D11, PRD §26–§27).
 *
 * ## Why the preview exists
 *
 * PRD §27 has the CLI print `Project: Payments Platform / Invited by: Alice`
 * and ask `Join project? [Y/n]` *before* joining. That confirmation is only
 * possible because `GET /invites/:code` answers a caller who is not yet a
 * member — which makes it the one endpoint in M1 that returns project data to
 * an outsider, and the reason {@link InvitePreviewResponseSchema} is built from
 * the narrow user and project shapes rather than the membership ones.
 *
 * ## What a bad code looks like
 *
 * Unknown, revoked, expired, and used-up all answer `INVITE_INVALID`. They are
 * one code deliberately: none is recoverable by the client, they all end in
 * "ask for a fresh invite", and distinguishing them would leak whether a given
 * code ever existed.
 *
 * ## Two names for one invite, and which one goes where
 *
 * An invite has a *code* — the bearer credential, typed by a human — and an
 * *identifier* — the `inv_` row key. They are addressed by different routes on
 * purpose:
 *
 * - `GET /invites/:code` and `POST /invites/:code/join` take the **code**,
 *   because the caller is somebody holding it and nothing else.
 * - `DELETE /projects/:id/invites/:inviteId` takes the **identifier**, because
 *   the caller is a member of the project acting on one of its invites, and
 *   revoking by code would put a live credential into a URL, a proxy log and a
 *   shell history in order to destroy it.
 *
 * @module
 */

import { z } from 'zod';

import { InviteId, ProjectId } from '../ids.js';
import { ProjectMembershipSchema, ProjectSchema, UserSummarySchema } from './entities.js';
import { InviteCodeSchema, TimestampSchema } from './primitives.js';

/**
 * Path parameters for a route under `/invites/:code`.
 *
 * The code is validated for shape only — enough to be a safe path segment — and
 * the lookup decides everything else. See {@link InviteCodeSchema} for why the
 * grammar is deliberately looser than the example in the plan.
 */
export const InviteCodeParamsSchema = z.object({
  /** The invite code, from the URL path. */
  code: InviteCodeSchema,
});

/** Path parameters for a route under `/invites/:code`. */
export type InviteCodeParams = z.infer<typeof InviteCodeParamsSchema>;

/**
 * Path parameters for `DELETE /projects/:id/invites/:inviteId`.
 *
 * Two identifiers of different kinds in one path, which the branded schemas
 * keep apart: after parsing, a project id in the invite position is a
 * `BAD_REQUEST` at the boundary rather than a query that quietly matches
 * nothing. `AgentProjectParamsSchema` is shaped the same way, for the same
 * reason.
 *
 * The project is in the path even though `inv_` identifiers are unique on their
 * own, because it is what the permission check is made against: the server
 * asserts membership of *this* project and then looks the invite up scoped to
 * it, so an identifier belonging to some other project answers exactly as an
 * invented one does.
 */
export const ProjectInviteParamsSchema = z.object({
  /** The project's identifier, from the URL path. */
  id: ProjectId.schema,
  /** The invite's identifier, from the URL path. */
  inviteId: InviteId.schema,
});

/** Path parameters for `DELETE /projects/:id/invites/:inviteId`. */
export type ProjectInviteParams = z.infer<typeof ProjectInviteParamsSchema>;

/**
 * `POST /projects/:id/invites` request: no fields.
 *
 * Plan §3 shows no body and fixes the policy in prose — 7 day expiry, unlimited
 * uses, revocable — so expiry and use limits are server defaults rather than
 * caller-supplied. `expiresIn` and `maxUses` are the obvious future fields, and
 * an empty object is what lets them be added without a version bump.
 *
 * Any member may create an invite (D11), not only an owner.
 */
export const CreateInviteRequestSchema = z.object({});

/** `POST /projects/:id/invites` request body. */
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

/**
 * `POST /projects/:id/invites` response: the identifier, the code, and when the
 * code stops working.
 *
 * ## Why the identifier is here now
 *
 * It was left out while `revoked_at` had no route to write it: an identifier
 * nothing accepts is a contract to honour for no reader. `DELETE
 * /projects/:id/invites/:inviteId` is that reader. Nothing else in M1 lists
 * invites, so this response is the *only* place an identifier is ever disclosed
 * — a caller who does not keep what they were handed here has no way to revoke
 * the code they just minted, short of the database.
 *
 * The identifier is not a second credential. It names a row and grants nothing:
 * it cannot be redeemed, and every route that takes one asserts membership of
 * the project first.
 *
 * ## Why it is optional in the schema and always sent by the server
 *
 * A client parsing this schema may be talking to a server older than the revoke
 * route, which sends `code` and `expiresAt` and nothing else. Declaring `id`
 * required would make that pairing fail at the parser rather than at the
 * feature, and would make adding the field a *narrowing* of a shipped
 * response — `scripts/protocol-snapshot.mjs` classifies a new required property
 * as breaking and demands a major bump, deliberately, because it does not know
 * which direction a schema travels in. Optional is both the honest contract and
 * the additive one. This server always sends it.
 */
export const CreateInviteResponseSchema = z.object({
  /**
   * The invite's identifier, for `DELETE /projects/:id/invites/:inviteId`.
   *
   * Absent only from a server that predates the revoke route; see above.
   */
  id: InviteId.schema.optional(),
  /** The code to share. Printed by the CLI and typed by the invitee. */
  code: InviteCodeSchema,
  /** When the code stops being redeemable. */
  expiresAt: TimestampSchema,
});

/** `POST /projects/:id/invites` response body. */
export type CreateInviteResponse = z.infer<typeof CreateInviteResponseSchema>;

/**
 * `GET /invites/:code` response: what this code would join you to.
 *
 * Answered to a caller who is not a member of the project, so it carries the
 * outsider-safe shapes: {@link ProjectSchema} without a role, and
 * {@link UserSummarySchema} without an email. See the module note.
 */
export const InvitePreviewResponseSchema = z.object({
  /** The project the code opens. */
  project: ProjectSchema,
  /** Who created the invite — the `Alice` in `Invited by: Alice`. */
  invitedBy: UserSummarySchema,
});

/** `GET /invites/:code` response body. */
export type InvitePreviewResponse = z.infer<typeof InvitePreviewResponseSchema>;

/** `POST /invites/:code/join` request: no fields. The code is in the path. */
export const JoinProjectRequestSchema = z.object({});

/** `POST /invites/:code/join` request body. */
export type JoinProjectRequest = z.infer<typeof JoinProjectRequestSchema>;

/**
 * `POST /invites/:code/join` response: the project just joined, with the
 * caller's new role.
 *
 * The project is returned rather than an empty body because PRD §27 prints
 * `Joined successfully. / Project: Payments Platform` afterwards, and a client
 * that had to call `GET /projects/:id` to render that line would be making a
 * second round trip for something the server already had in hand. The role is
 * always `member`; joining never confers ownership.
 *
 * Joining a project the caller is already in is a success with their existing
 * role, not a `CONFLICT`: the user asked to be a member and they are one.
 */
export const JoinProjectResponseSchema = z.object({
  /** The project now joined, with the caller's role in it. */
  project: ProjectMembershipSchema,
});

/** `POST /invites/:code/join` response body. */
export type JoinProjectResponse = z.infer<typeof JoinProjectResponseSchema>;

/**
 * `DELETE /projects/:id/invites/:inviteId` response: no fields.
 *
 * ## Who may revoke: any member of the project
 *
 * The same rule as creating one (D11), and the same assertion behind it. The
 * alternative considered was "the member who minted it, plus any owner", which
 * is the shape most systems reach for; it is wrong here:
 *
 * - **An invite is not its creator's property.** It is a hole in the project's
 *   perimeter, and every member bears its consequences equally — whoever
 *   redeems that code reads *their* messages too. A member who has to ask
 *   permission before closing a door into the room they live in is the wrong
 *   default for a safety control.
 * - **The permissions must not be asymmetric in that direction.** D11 already
 *   lets any member widen the boundary unilaterally, and with no approval step.
 *   A project where any member can open a door and only some can close one is
 *   backwards: revocation is the fail-safe direction, and an error toward it
 *   costs one re-mint while an error away from it leaves a bearer credential
 *   live for up to seven days.
 * - **The narrow rule fails exactly when it is needed.** Its useful half is
 *   "owners may revoke any", and D11 optimises for small teams, where the sole
 *   owner is often the only owner. A member who spots the code in a public
 *   repository at 3 a.m. would have to wait for them.
 * - **There is no invite listing to sweep.** No M1 endpoint enumerates invites,
 *   so an identifier reaches only whoever minted it — the broad rule grants
 *   almost no griefing surface it does not already imply.
 * - **"Creator" would be a new kind of rule.** The permission matrix in
 *   `services/authorization.ts` knows members and owners, not per-row authors.
 *   Adding one for invites would mean deciding afresh what a caller is told
 *   about an invite that exists but is not theirs, for a rule whose only effect
 *   is to *prevent* a safety action.
 *
 * ## Why the body is empty, and why revoking twice succeeds
 *
 * There is nothing to return: the invite's only interesting property afterwards
 * is that it no longer works, and the caller just asked for that. Revocation is
 * idempotent — a second call is a success, not a `CONFLICT` — because the
 * caller's intent ("this code must not work") is already satisfied, and because
 * a retried request over a flaky connection is not an error. The recorded
 * `revoked_at` stays the first one.
 *
 * An identifier that names no invite of this project — including one belonging
 * to a project the caller cannot see — is `NOT_FOUND`, indistinguishably from
 * one that never existed.
 */
export const RevokeInviteResponseSchema = z.object({});

/** `DELETE /projects/:id/invites/:inviteId` response body. */
export type RevokeInviteResponse = z.infer<typeof RevokeInviteResponseSchema>;
