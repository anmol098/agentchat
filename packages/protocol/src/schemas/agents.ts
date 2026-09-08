/**
 * Agent endpoints: listing your own agents, creating, renaming, soft-deleting,
 * and moving them in and out of projects (plan §3 "Agents", D13).
 *
 * ## An agent is owned, then joined
 *
 * `agents` belongs to a user; `agent_projects` is a separate table. Everything
 * in this module reflects that split: `POST /agents` takes only a name, and a
 * second call puts the agent in a project. It also means the authorization
 * rules differ — renaming an agent needs ownership, joining it to a project
 * needs ownership *and* membership of that project — so a route cannot infer
 * one check from the other.
 *
 * ## Deletion is soft
 *
 * D13: `DELETE /agents/:id` sets `deleted_at`, ends the agent's sessions and
 * drops its project memberships, but historical messages keep referencing it.
 * The name becomes reusable. A later request naming the deleted agent gets
 * `AGENT_DELETED` rather than `NOT_FOUND`, because the caller demonstrably had
 * a valid id and the remedy is different.
 *
 * @module
 */

import { z } from 'zod';

import { AgentId, ProjectId } from '../ids.js';
import { AgentSchema } from './entities.js';
import { AgentNameSchema, listResponse } from './primitives.js';

/**
 * Path parameters for any route under `/agents/:id`.
 *
 * Parsed with the branded agent schema, so a handler receives an `AgentId` and
 * a project id in the path is a `BAD_REQUEST` at the boundary rather than a
 * query that returns nothing.
 */
export const AgentIdParamsSchema = z.object({
  /** The agent's identifier, from the URL path. */
  id: AgentId.schema,
});

/** Path parameters for a route under `/agents/:id`. */
export type AgentIdParams = z.infer<typeof AgentIdParamsSchema>;

/**
 * Path parameters for `DELETE /agents/:id/projects/:pid`.
 *
 * Two identifiers of different kinds in one path is exactly the mistake the
 * branded types exist to catch: `id` is an `AgentId` and `pid` is a
 * `ProjectId`, and after parsing they are no longer interchangeable.
 */
export const AgentProjectParamsSchema = z.object({
  /** The agent's identifier, from the URL path. */
  id: AgentId.schema,
  /** The project's identifier, from the URL path. */
  pid: ProjectId.schema,
});

/** Path parameters for `DELETE /agents/:id/projects/:pid`. */
export type AgentProjectParams = z.infer<typeof AgentProjectParamsSchema>;

/**
 * `GET /agents` response: the caller's own agents.
 *
 * Only the caller's — the endpoint is `(mine)` in plan §3 — and never
 * soft-deleted ones. To see another member's agents, use
 * `GET /projects/:id/agents`.
 */
export const ListAgentsResponseSchema = listResponse(AgentSchema);

/** `GET /agents` response body. */
export type ListAgentsResponse = z.infer<typeof ListAgentsResponseSchema>;

/**
 * `POST /agents` request: just a name.
 *
 * No project: an agent is created and *then* joined to projects, which is what
 * lets one agent participate in several. A name already taken by one of the
 * caller's live agents is a `CONFLICT`; a name taken by one they deleted is
 * free again (D13).
 */
export const CreateAgentRequestSchema = z.object({
  /** The agent's name, unique among the caller's live agents. */
  name: AgentNameSchema,
});

/** `POST /agents` request body. */
export type CreateAgentRequest = z.infer<typeof CreateAgentRequestSchema>;

/** `POST /agents` response: the created agent. */
export const CreateAgentResponseSchema = AgentSchema;

/** `POST /agents` response body. */
export type CreateAgentResponse = z.infer<typeof CreateAgentResponseSchema>;

/**
 * `PATCH /agents/:id` request: the new name.
 *
 * `name` is required rather than optional even though the method is `PATCH`,
 * because plan §3 gives this endpoint exactly one field and a patch with
 * nothing in it is a request the server cannot act on. Should another mutable
 * field ever appear, that is the moment to make both optional — and it will be
 * an additive change.
 */
export const RenameAgentRequestSchema = z.object({
  /** The agent's new name, subject to the same uniqueness rule as creation. */
  name: AgentNameSchema,
});

/** `PATCH /agents/:id` request body. */
export type RenameAgentRequest = z.infer<typeof RenameAgentRequestSchema>;

/**
 * `PATCH /agents/:id` response: the agent as it now stands.
 *
 * Returned in full, including the bumped `updatedAt`, so a client refreshes its
 * cached copy from the response rather than by patching its own local object
 * and hoping the server agreed.
 */
export const RenameAgentResponseSchema = AgentSchema;

/** `PATCH /agents/:id` response body. */
export type RenameAgentResponse = z.infer<typeof RenameAgentResponseSchema>;

/**
 * `DELETE /agents/:id` response: no fields.
 *
 * The soft-deleted agent is not echoed back. It no longer appears in any
 * listing and cannot be sent to, so a representation of it would only invite a
 * client to keep rendering something that is gone. See the module note on what
 * deletion actually does.
 */
export const DeleteAgentResponseSchema = z.object({});

/** `DELETE /agents/:id` response body. */
export type DeleteAgentResponse = z.infer<typeof DeleteAgentResponseSchema>;

/**
 * `POST /agents/:id/projects` request: which project to join.
 *
 * The caller must own the agent *and* be a member of the project. Owning the
 * agent is not enough — that would let anyone add their agent to any project
 * whose id they had seen.
 */
export const AddAgentToProjectRequestSchema = z.object({
  /** The project the agent should join. */
  projectId: ProjectId.schema,
});

/** `POST /agents/:id/projects` request body. */
export type AddAgentToProjectRequest = z.infer<typeof AddAgentToProjectRequestSchema>;

/**
 * `POST /agents/:id/projects` response: no fields.
 *
 * Idempotent: joining a project the agent is already in succeeds. The
 * membership itself has no fields a client needs beyond the pair it just sent.
 */
export const AddAgentToProjectResponseSchema = z.object({});

/** `POST /agents/:id/projects` response body. */
export type AddAgentToProjectResponse = z.infer<typeof AddAgentToProjectResponseSchema>;

/**
 * `DELETE /agents/:id/projects/:pid` response: no fields.
 *
 * Idempotent, like its counterpart. Removing an agent from a project ends its
 * sessions there; messages already sent keep referencing it.
 */
export const RemoveAgentFromProjectResponseSchema = z.object({});

/** `DELETE /agents/:id/projects/:pid` response body. */
export type RemoveAgentFromProjectResponse = z.infer<typeof RemoveAgentFromProjectResponseSchema>;
