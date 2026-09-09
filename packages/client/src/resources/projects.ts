/**
 * `client.projects` — listing, creating, reading, leaving, inviting to, and
 * discovering the agents in a project (plan §3 "Projects").
 *
 * Every list here resolves to `{ items: [...] }` rather than a bare array
 * (D17). The envelope is not unwrapped on the way out: unwrapping it would put
 * the client back in the position of having nowhere to surface a pagination
 * cursor the day the server starts sending one, which is the entire reason the
 * envelope exists.
 *
 * `POST /projects/:id/invites` and `DELETE /projects/:id/invites/:inviteId`
 * live here rather than in `client.invites` because they are project
 * operations — each needs a project id and project membership. `client.invites`
 * holds the two operations that start from a code and know nothing about a
 * project yet.
 *
 * The split is also the reason {@link ProjectsApi.revokeInvite} takes an
 * identifier and not a code. Revoking by code would put a live bearer
 * credential into a URL, a proxy log and a shell history in order to destroy
 * it, so `DELETE /projects/:id/invites/:inviteId` addresses the row instead —
 * and the identifier reaches a caller from exactly one place, the response to
 * {@link ProjectsApi.createInvite}. Nothing turns a code back into one.
 *
 * @module
 */

import type {
  CreateInviteResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectResponse,
  InviteId,
  ListProjectAgentsResponse,
  ListProjectsResponse,
  ProjectId,
} from '@agentchat/protocol';
import {
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  GetProjectResponseSchema,
  LeaveProjectRequestSchema,
  LeaveProjectResponseSchema,
  ListProjectAgentsResponseSchema,
  ListProjectsResponseSchema,
  RevokeInviteResponseSchema,
} from '@agentchat/protocol';

import type { ApiClient, RequestOptions } from '../api.js';
import { parseRequest, signalOf } from '../api.js';

/** Project endpoints. Reached as `client.projects`. */
export class ProjectsApi {
  readonly #api: ApiClient;

  /**
   * @param api - The request pipeline.
   */
  public constructor(api: ApiClient) {
    this.#api = api;
  }

  /**
   * Every project the caller is a member of: `GET /projects`.
   *
   * @param options - Per-call options.
   * @returns `{ items }`, each carrying the caller's role in that project.
   * @throws {ProtocolError} `AUTH_REQUIRED` if nobody is logged in.
   */
  public list(options?: RequestOptions): Promise<ListProjectsResponse> {
    return this.#api.send({
      method: 'GET',
      path: '/projects',
      auth: 'required',
      response: ListProjectsResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Creates a project: `POST /projects`.
   *
   * @param request - The name, and optionally an explicit slug. Omitting the
   *   slug lets the server derive one; supplying one that is taken is a
   *   `CONFLICT` rather than a silently suffixed near-miss.
   * @param options - Per-call options.
   * @returns The created project, with the caller's role — always `owner`.
   * @throws {ApiError} `CONFLICT` if the slug is already in use.
   */
  public async create(
    request: CreateProjectRequest,
    options?: RequestOptions,
  ): Promise<CreateProjectResponse> {
    const body = parseRequest(CreateProjectRequestSchema, request, 'The project to create');
    return await this.#api.send({
      method: 'POST',
      path: '/projects',
      auth: 'required',
      body,
      response: CreateProjectResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * One project: `GET /projects/:id`.
   *
   * @param projectId - The project to read.
   * @param options - Per-call options.
   * @returns The project, with the caller's role in it.
   * @throws {ApiError} `NOT_FOUND` if it does not exist *or* the caller is not a
   *   member. The two are indistinguishable on purpose.
   */
  public get(projectId: ProjectId, options?: RequestOptions): Promise<GetProjectResponse> {
    return this.#api.send({
      method: 'GET',
      path: `/projects/${projectId}`,
      auth: 'required',
      response: GetProjectResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Leaves a project: `POST /projects/:id/leave`.
   *
   * @param projectId - The project to leave.
   * @param options - Per-call options.
   * @throws {ApiError} `NOT_FOUND` if the caller is not a member.
   */
  public async leave(projectId: ProjectId, options?: RequestOptions): Promise<void> {
    await this.#api.send({
      method: 'POST',
      path: `/projects/${projectId}/leave`,
      auth: 'required',
      body: LeaveProjectRequestSchema.parse({}),
      response: LeaveProjectResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Mints an invite code: `POST /projects/:id/invites`.
   *
   * Any member may do this, not only an owner (D11). Expiry and use limits are
   * server policy, not caller-supplied.
   *
   * @param projectId - The project to invite into.
   * @param options - Per-call options.
   * @returns The code to share and when it stops working.
   * @throws {ApiError} `NOT_FOUND` if the caller is not a member.
   */
  public createInvite(
    projectId: ProjectId,
    options?: RequestOptions,
  ): Promise<CreateInviteResponse> {
    return this.#api.send({
      method: 'POST',
      path: `/projects/${projectId}/invites`,
      auth: 'required',
      body: CreateInviteRequestSchema.parse({}),
      response: CreateInviteResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Revokes an invite: `DELETE /projects/:id/invites/:inviteId`.
   *
   * Any member of the project may revoke any of its invites — the same rule as
   * creating one (D11). An invite is a hole in the project's perimeter and
   * every member bears its consequences equally, so revocation, which is the
   * fail-safe direction, is not narrower than the action it undoes.
   *
   * Addressed by identifier and never by code. The identifier is disclosed in
   * exactly one place, {@link ProjectsApi.createInvite}'s response, and no
   * endpoint turns a code back into one; a caller that discarded it cannot
   * revoke short of the database.
   *
   * Idempotent: revoking an already-revoked invite succeeds and leaves the
   * first recorded revocation instant alone. Nothing is returned, because the
   * invite's only interesting property afterwards is that it no longer works
   * and the caller just asked for that.
   *
   * @param projectId - The project the invite belongs to. It is what membership
   *   is asserted against, so an invite of another project answers exactly as
   *   an invented identifier does.
   * @param inviteId - The invite to revoke.
   * @param options - Per-call options.
   * @throws {ApiError} `NOT_FOUND` if no invite of this project has that
   *   identifier — indistinguishably from one that never existed, and including
   *   the case where the caller is not a member.
   * @throws {ApiError} `BAD_REQUEST` if either identifier is malformed,
   *   including a project id in the invite position.
   */
  public async revokeInvite(
    projectId: ProjectId,
    inviteId: InviteId,
    options?: RequestOptions,
  ): Promise<void> {
    await this.#api.send({
      method: 'DELETE',
      path: `/projects/${projectId}/invites/${inviteId}`,
      auth: 'required',
      response: RevokeInviteResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Who else is in this project, and are they listening:
   * `GET /projects/:id/agents` (PRD §21).
   *
   * @param projectId - The project to inspect.
   * @param options - Per-call options.
   * @returns `{ items }` of agent, owner, and presence. Includes the caller's
   *   own agents; excludes soft-deleted ones.
   * @throws {ApiError} `NOT_FOUND` if the caller is not a member.
   */
  public listAgents(
    projectId: ProjectId,
    options?: RequestOptions,
  ): Promise<ListProjectAgentsResponse> {
    return this.#api.send({
      method: 'GET',
      path: `/projects/${projectId}/agents`,
      auth: 'required',
      response: ListProjectAgentsResponseSchema,
      ...signalOf(options),
    });
  }
}
