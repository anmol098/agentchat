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
 * @module
 */

import { z } from 'zod';

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
 * `POST /projects/:id/invites` response: the code and when it stops working.
 *
 * Exactly the two fields plan §3 names. The invite's own `inv_` identifier is
 * not returned, because M1 has no endpoint that takes one — there is no revoke
 * route in §3 — and returning an identifier nothing accepts would be a
 * contract to honour for no reader.
 */
export const CreateInviteResponseSchema = z.object({
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
