/**
 * `client.agents` — the caller's own agents, and their project memberships
 * (plan §3 "Agents", D13).
 *
 * An agent is owned by a user and *joins* projects, so creating one and putting
 * it in a project are two calls. `list()` answers only with the caller's own
 * agents; to see anyone else's, ask a project
 * (`client.projects.listAgents`).
 *
 * @module
 */

import type {
  AddAgentToProjectRequest,
  AgentId,
  CreateAgentRequest,
  CreateAgentResponse,
  ListAgentsResponse,
  ProjectId,
  RenameAgentRequest,
  RenameAgentResponse,
} from '@agentchat/protocol';
import {
  AddAgentToProjectRequestSchema,
  AddAgentToProjectResponseSchema,
  CreateAgentRequestSchema,
  CreateAgentResponseSchema,
  DeleteAgentResponseSchema,
  ListAgentsResponseSchema,
  RemoveAgentFromProjectResponseSchema,
  RenameAgentRequestSchema,
  RenameAgentResponseSchema,
} from '@agentchat/protocol';

import type { ApiClient, RequestOptions } from '../api.js';
import { parseRequest, signalOf } from '../api.js';

/** Agent endpoints. Reached as `client.agents`. */
export class AgentsApi {
  readonly #api: ApiClient;

  /**
   * @param api - The request pipeline.
   */
  public constructor(api: ApiClient) {
    this.#api = api;
  }

  /**
   * The caller's own agents: `GET /agents`.
   *
   * @param options - Per-call options.
   * @returns `{ items }` of live agents. Soft-deleted ones never appear.
   * @throws {ProtocolError} `AUTH_REQUIRED` if nobody is logged in.
   */
  public list(options?: RequestOptions): Promise<ListAgentsResponse> {
    return this.#api.send({
      method: 'GET',
      path: '/agents',
      auth: 'required',
      response: ListAgentsResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Creates an agent: `POST /agents`.
   *
   * @param request - The agent's name, unique among the caller's live agents.
   * @param options - Per-call options.
   * @returns The created agent.
   * @throws {ApiError} `CONFLICT` if the caller already has a live agent with
   *   that name. A name freed by a deletion is available again (D13).
   */
  public async create(
    request: CreateAgentRequest,
    options?: RequestOptions,
  ): Promise<CreateAgentResponse> {
    const body = parseRequest(CreateAgentRequestSchema, request, 'The agent to create');
    return await this.#api.send({
      method: 'POST',
      path: '/agents',
      auth: 'required',
      body,
      response: CreateAgentResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Renames an agent: `PATCH /agents/:id`.
   *
   * @param agentId - The agent to rename. The caller must own it.
   * @param request - The new name.
   * @param options - Per-call options.
   * @returns The agent as it now stands, including the bumped `updatedAt`.
   * @throws {ApiError} `FORBIDDEN` if the caller does not own it; `CONFLICT` if
   *   the name is taken; `AGENT_DELETED` if it has been deleted.
   */
  public async rename(
    agentId: AgentId,
    request: RenameAgentRequest,
    options?: RequestOptions,
  ): Promise<RenameAgentResponse> {
    const body = parseRequest(RenameAgentRequestSchema, request, 'The new name for the agent');
    return await this.#api.send({
      method: 'PATCH',
      path: `/agents/${agentId}`,
      auth: 'required',
      body,
      response: RenameAgentResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Soft-deletes an agent: `DELETE /agents/:id` (D13).
   *
   * The agent's sessions end and its project memberships drop, but messages it
   * sent keep referencing it and its name becomes reusable.
   *
   * @param agentId - The agent to delete. The caller must own it.
   * @param options - Per-call options.
   * @throws {ApiError} `FORBIDDEN` if the caller does not own it.
   */
  public async delete(agentId: AgentId, options?: RequestOptions): Promise<void> {
    await this.#api.send({
      method: 'DELETE',
      path: `/agents/${agentId}`,
      auth: 'required',
      response: DeleteAgentResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Joins an agent to a project: `POST /agents/:id/projects`.
   *
   * Idempotent. The caller must own the agent *and* be a member of the project.
   *
   * @param agentId - The agent to join.
   * @param request - The project to join it to.
   * @param options - Per-call options.
   * @throws {ApiError} `FORBIDDEN` if the caller does not own the agent or is
   *   not a member of the project.
   */
  public async addToProject(
    agentId: AgentId,
    request: AddAgentToProjectRequest,
    options?: RequestOptions,
  ): Promise<void> {
    await this.#api.send({
      method: 'POST',
      path: `/agents/${agentId}/projects`,
      auth: 'required',
      body: parseRequest(
        AddAgentToProjectRequestSchema,
        request,
        'The project for the agent to join',
      ),
      response: AddAgentToProjectResponseSchema,
      ...signalOf(options),
    });
  }

  /**
   * Removes an agent from a project: `DELETE /agents/:id/projects/:pid`.
   *
   * Idempotent. Ends the agent's sessions in that project; messages already sent
   * keep referencing it.
   *
   * @param agentId - The agent to remove.
   * @param projectId - The project to remove it from.
   * @param options - Per-call options.
   * @throws {ApiError} `FORBIDDEN` if the caller does not own the agent.
   */
  public async removeFromProject(
    agentId: AgentId,
    projectId: ProjectId,
    options?: RequestOptions,
  ): Promise<void> {
    await this.#api.send({
      method: 'DELETE',
      path: `/agents/${agentId}/projects/${projectId}`,
      auth: 'required',
      response: RemoveAgentFromProjectResponseSchema,
      ...signalOf(options),
    });
  }
}
