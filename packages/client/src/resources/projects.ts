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
 * `POST /projects/:id/invites` lives here rather than in `client.invites`
 * because it is a project operation — it needs a project id and project
 * membership. `client.invites` holds the two operations that start from a code
 * and know nothing about a project yet.
 *
 * @module
 */

import type {
  CreateInviteResponse,
  CreateProjectRequest,
  CreateProjectResponse,
  GetProjectResponse,
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
