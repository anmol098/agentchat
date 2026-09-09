import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as pkg from '../index.js';
import * as schemas from './index.js';

/**
 * Every milestone 1 endpoint from plan section 3, with the schemas that define
 * it. `request: null` means the endpoint has no body (a GET, or a DELETE).
 *
 * This table is the checklist for "zod schemas exist for every M1 endpoint". A
 * route added to the plan without a schema shows up here as a missing name, and
 * a schema removed shows up as a failing lookup. Sessions and messages are
 * absent on purpose; see the module note in ./index.ts.
 */
const M1_ENDPOINTS: ReadonlyArray<{
  readonly endpoint: string;
  readonly params?: string;
  readonly request: string | null;
  readonly response: string;
}> = [
  // Auth
  {
    endpoint: 'POST /auth/device/start',
    request: 'StartDeviceAuthorizationRequestSchema',
    response: 'StartDeviceAuthorizationResponseSchema',
  },
  {
    endpoint: 'POST /auth/device/poll',
    request: 'PollDeviceAuthorizationRequestSchema',
    response: 'PollDeviceAuthorizationResponseSchema',
  },
  {
    endpoint: 'POST /auth/refresh',
    request: 'RefreshTokensRequestSchema',
    response: 'RefreshTokensResponseSchema',
  },
  {
    endpoint: 'POST /auth/logout',
    request: 'LogoutRequestSchema',
    response: 'LogoutResponseSchema',
  },
  { endpoint: 'GET /me', request: null, response: 'GetCurrentUserResponseSchema' },
  { endpoint: 'GET /version', request: null, response: 'GetVersionResponseSchema' },

  // Projects
  { endpoint: 'GET /projects', request: null, response: 'ListProjectsResponseSchema' },
  {
    endpoint: 'POST /projects',
    request: 'CreateProjectRequestSchema',
    response: 'CreateProjectResponseSchema',
  },
  {
    endpoint: 'GET /projects/:id',
    params: 'ProjectIdParamsSchema',
    request: null,
    response: 'GetProjectResponseSchema',
  },
  {
    endpoint: 'POST /projects/:id/invites',
    params: 'ProjectIdParamsSchema',
    request: 'CreateInviteRequestSchema',
    response: 'CreateInviteResponseSchema',
  },
  {
    endpoint: 'GET /invites/:code',
    params: 'InviteCodeParamsSchema',
    request: null,
    response: 'InvitePreviewResponseSchema',
  },
  {
    endpoint: 'POST /invites/:code/join',
    params: 'InviteCodeParamsSchema',
    request: 'JoinProjectRequestSchema',
    response: 'JoinProjectResponseSchema',
  },
  {
    endpoint: 'DELETE /projects/:id/invites/:inviteId',
    params: 'ProjectInviteParamsSchema',
    request: null,
    response: 'RevokeInviteResponseSchema',
  },
  {
    endpoint: 'POST /projects/:id/leave',
    params: 'ProjectIdParamsSchema',
    request: 'LeaveProjectRequestSchema',
    response: 'LeaveProjectResponseSchema',
  },
  {
    endpoint: 'GET /projects/:id/agents',
    params: 'ProjectIdParamsSchema',
    request: null,
    response: 'ListProjectAgentsResponseSchema',
  },

  // Agents
  { endpoint: 'GET /agents', request: null, response: 'ListAgentsResponseSchema' },
  {
    endpoint: 'POST /agents',
    request: 'CreateAgentRequestSchema',
    response: 'CreateAgentResponseSchema',
  },
  {
    endpoint: 'PATCH /agents/:id',
    params: 'AgentIdParamsSchema',
    request: 'RenameAgentRequestSchema',
    response: 'RenameAgentResponseSchema',
  },
  {
    endpoint: 'DELETE /agents/:id',
    params: 'AgentIdParamsSchema',
    request: null,
    response: 'DeleteAgentResponseSchema',
  },
  {
    endpoint: 'POST /agents/:id/projects',
    params: 'AgentIdParamsSchema',
    request: 'AddAgentToProjectRequestSchema',
    response: 'AddAgentToProjectResponseSchema',
  },
  {
    endpoint: 'DELETE /agents/:id/projects/:pid',
    params: 'AgentProjectParamsSchema',
    request: null,
    response: 'RemoveAgentFromProjectResponseSchema',
  },
];

const exported = schemas as unknown as Record<string, unknown>;
const fromPackageRoot = pkg as unknown as Record<string, unknown>;

describe('milestone 1 endpoint coverage', () => {
  for (const { endpoint, params, request, response } of M1_ENDPOINTS) {
    it(`${endpoint} has the schemas that define it`, () => {
      const names = [params, request, response].filter(
        (name): name is string => typeof name === 'string',
      );
      for (const name of names) {
        expect(exported[name], `${endpoint} is missing ${name}`).toBeInstanceOf(z.ZodType);
      }
    });
  }

  it('covers every endpoint plan section 3 lists for M1', () => {
    // A count rather than a set comparison, because the endpoint strings above
    // are the assertion. If the plan grows a route, this number moves in the
    // same pull request that adds its schemas.
    expect(M1_ENDPOINTS).toHaveLength(21);
  });
});

describe('package index', () => {
  it('re-exports every schema, so nothing has to reach into a subpath', () => {
    // packages/client and server both import from "@agentchat/protocol". A
    // schema reachable only via ./schemas/... would be a second import style
    // for the same contract.
    for (const name of Object.keys(exported)) {
      expect(fromPackageRoot[name], `${name} is not re-exported from the index`).toBe(
        exported[name],
      );
    }
  });

  it('still exports the identifiers and error contract T-005 established', () => {
    for (const name of ['AgentId', 'ProjectId', 'ErrorCode', 'ProtocolError', 'PROTOCOL_VERSION']) {
      expect(fromPackageRoot[name], `${name} disappeared from the index`).toBeDefined();
    }
  });
});

describe('additive tolerance', () => {
  it('strips unknown properties everywhere rather than rejecting them', () => {
    // Plan section 12.4 makes protocol changes additive within a major version.
    // A response schema that rejected an unrecognised field would turn "a new
    // field shipped" into "every old client fails".
    const parsed = schemas.CreateInviteResponseSchema.parse({
      code: 'ANET-7K4M-Q2P9',
      expiresAt: '2026-09-15T12:00:00.000Z',
      maxUses: 5,
      addedLater: { nested: true },
    });
    expect(parsed).toStrictEqual({
      code: 'ANET-7K4M-Q2P9',
      expiresAt: '2026-09-15T12:00:00.000Z',
    });
  });
});
