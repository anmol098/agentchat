/**
 * Project endpoints: listing, creating, reading, leaving, and agent discovery
 * (plan §3 "Projects", PRD §21).
 *
 * ## List responses are enveloped
 *
 * Plan §3 sketches `GET /projects/:id/agents` as a bare array. Every list here
 * returns `{ items: [...] }` instead; see {@link listResponse} for why. In
 * short, a bare array cannot carry a pagination cursor, and §12.4 makes adding
 * one to it a major-version change. The plan is amended to match.
 *
 * @module
 */

import { z } from 'zod';

import { ProjectId } from '../ids.js';
import { ProjectAgentSchema, ProjectMembershipSchema } from './entities.js';
import { listResponse, ProjectNameSchema, ProjectSlugSchema } from './primitives.js';

/**
 * Path parameters for any route under `/projects/:id`.
 *
 * The identifier is parsed with the branded project schema, so a route handler
 * receives a `ProjectId` and cannot pass it where an `AgentId` belongs. A path
 * segment that is not a well-formed project id is a `BAD_REQUEST`, never a
 * lookup that happens to miss.
 */
export const ProjectIdParamsSchema = z.object({
  /** The project's identifier, from the URL path. */
  id: ProjectId.schema,
});

/** Path parameters for a route under `/projects/:id`. */
export type ProjectIdParams = z.infer<typeof ProjectIdParamsSchema>;

/**
 * `GET /projects` response: every project the caller is a member of, each with
 * the caller's own role in it.
 *
 * Membership is the filter, so a project the caller has left is absent rather
 * than present with no role.
 */
export const ListProjectsResponseSchema = listResponse(ProjectMembershipSchema);

/** `GET /projects` response body. */
export type ListProjectsResponse = z.infer<typeof ListProjectsResponseSchema>;

/**
 * `POST /projects` request.
 *
 * `slug` is optional in plan §3. When it is omitted the server derives one from
 * `name`; when it is given it is used verbatim, and a slug already in use is a
 * `CONFLICT` rather than a silently suffixed near-miss, because the caller may
 * be about to commit it to `.agentchat/config.json` (D12) and needs to know
 * which project that file will resolve to.
 */
export const CreateProjectRequestSchema = z.object({
  /** Human-readable name, e.g. `Payments Platform`. */
  name: ProjectNameSchema,
  /** Optional explicit slug. Derived from `name` when absent. */
  slug: ProjectSlugSchema.optional(),
});

/** `POST /projects` request body. */
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

/**
 * `POST /projects` response: the created project, with the caller's role.
 *
 * The role is always `owner` — the creator of a project owns it — but it is
 * carried by the shared membership shape rather than asserted here, so a client
 * that renders a project list and a freshly created project uses one code path.
 */
export const CreateProjectResponseSchema = ProjectMembershipSchema;

/** `POST /projects` response body. */
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;

/**
 * `GET /projects/:id` response: one project, with the caller's role.
 *
 * A caller who is not a member gets `NOT_FOUND`, not `FORBIDDEN`: whether a
 * project exists is itself information they are not entitled to.
 */
export const GetProjectResponseSchema = ProjectMembershipSchema;

/** `GET /projects/:id` response body. */
export type GetProjectResponse = z.infer<typeof GetProjectResponseSchema>;

/** `POST /projects/:id/leave` request: no fields. */
export const LeaveProjectRequestSchema = z.object({});

/** `POST /projects/:id/leave` request body. */
export type LeaveProjectRequest = z.infer<typeof LeaveProjectRequestSchema>;

/**
 * `POST /projects/:id/leave` response: no fields.
 *
 * There is nothing useful to return — the caller can no longer read the project
 * they just left — so the body is `{}`.
 */
export const LeaveProjectResponseSchema = z.object({});

/** `POST /projects/:id/leave` response body. */
export type LeaveProjectResponse = z.infer<typeof LeaveProjectResponseSchema>;

/**
 * `GET /projects/:id/agents` response: who else is in this project, and are
 * they listening (PRD §21).
 *
 * Includes the caller's own agents. Excludes soft-deleted ones (D13).
 */
export const ListProjectAgentsResponseSchema = listResponse(ProjectAgentSchema);

/** `GET /projects/:id/agents` response body. */
export type ListProjectAgentsResponse = z.infer<typeof ListProjectAgentsResponseSchema>;
