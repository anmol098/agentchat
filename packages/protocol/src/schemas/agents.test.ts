import { describe, expect, it } from 'vitest';

import { AgentId, ProjectId, UserId } from '../ids.js';
import {
  AddAgentToProjectRequestSchema,
  AddAgentToProjectResponseSchema,
  AgentIdParamsSchema,
  AgentProjectParamsSchema,
  CreateAgentRequestSchema,
  CreateAgentResponseSchema,
  DeleteAgentResponseSchema,
  ListAgentsResponseSchema,
  RemoveAgentFromProjectResponseSchema,
  RenameAgentRequestSchema,
  RenameAgentResponseSchema,
} from './agents.js';

const userId = UserId.generate();
const projectId = ProjectId.generate();
const agentId = AgentId.generate();

const agent = {
  id: agentId,
  userId,
  name: 'backend',
  createdAt: '2026-09-08T12:00:00.000Z',
  updatedAt: '2026-09-08T12:00:00.000Z',
};

describe('AgentIdParamsSchema', () => {
  it('parses an agent id out of the path', () => {
    expect(AgentIdParamsSchema.parse({ id: agentId })).toStrictEqual({ id: agentId });
  });

  it('rejects a project id in the agent slot', () => {
    expect(AgentIdParamsSchema.safeParse({ id: projectId }).success).toBe(false);
  });
});

describe('AgentProjectParamsSchema', () => {
  it('keeps the two identifiers in a path distinct', () => {
    expect(AgentProjectParamsSchema.parse({ id: agentId, pid: projectId })).toStrictEqual({
      id: agentId,
      pid: projectId,
    });
  });

  it('rejects the pair swapped, which is the whole point of branding them', () => {
    expect(AgentProjectParamsSchema.safeParse({ id: projectId, pid: agentId }).success).toBe(false);
  });

  it('requires both', () => {
    expect(AgentProjectParamsSchema.safeParse({ id: agentId }).success).toBe(false);
    expect(AgentProjectParamsSchema.safeParse({ pid: projectId }).success).toBe(false);
  });
});

describe('ListAgentsResponseSchema', () => {
  it('round-trips the caller-s own agents as a bare array', () => {
    expect(ListAgentsResponseSchema.parse([agent])).toStrictEqual([agent]);
    expect(ListAgentsResponseSchema.parse([])).toStrictEqual([]);
  });

  it('rejects an envelope', () => {
    expect(ListAgentsResponseSchema.safeParse({ agents: [agent] }).success).toBe(false);
  });
});

describe('CreateAgentRequestSchema', () => {
  it('takes only a name, because an agent joins projects separately', () => {
    expect(CreateAgentRequestSchema.parse({ name: 'backend' })).toStrictEqual({
      name: 'backend',
    });
  });

  it('drops a project a caller tried to smuggle into creation', () => {
    expect(CreateAgentRequestSchema.parse({ name: 'backend', projectId })).toStrictEqual({
      name: 'backend',
    });
  });

  it('enforces the plan-s name grammar at the boundary', () => {
    for (const name of ['Backend', 'back end', 'back/end', '-backend', '', 'a'.repeat(33)]) {
      expect(CreateAgentRequestSchema.safeParse({ name }).success).toBe(false);
    }
  });

  it('accepts the longest legal name', () => {
    expect(CreateAgentRequestSchema.safeParse({ name: 'a'.repeat(32) }).success).toBe(true);
  });
});

describe('CreateAgentResponseSchema and RenameAgentResponseSchema', () => {
  it('both return the agent in full', () => {
    expect(CreateAgentResponseSchema.parse(agent)).toStrictEqual(agent);
    const renamed = { ...agent, name: 'backend-2', updatedAt: '2026-09-08T13:00:00.000Z' };
    expect(RenameAgentResponseSchema.parse(renamed)).toStrictEqual(renamed);
  });
});

describe('RenameAgentRequestSchema', () => {
  it('requires the new name even though the method is PATCH', () => {
    // Plan section 3 gives this endpoint exactly one field, and a patch with
    // nothing in it is a request the server cannot act on.
    expect(RenameAgentRequestSchema.parse({ name: 'backend-2' })).toStrictEqual({
      name: 'backend-2',
    });
    expect(RenameAgentRequestSchema.safeParse({}).success).toBe(false);
  });

  it('holds a rename to the same grammar as a creation', () => {
    expect(RenameAgentRequestSchema.safeParse({ name: 'Backend' }).success).toBe(false);
  });
});

describe('DeleteAgentResponseSchema', () => {
  it('carries no fields', () => {
    expect(DeleteAgentResponseSchema.parse({})).toStrictEqual({});
  });

  it('does not echo the soft-deleted agent back', () => {
    // D13 deletion ends sessions and drops memberships; a representation would
    // only invite a client to keep rendering something that is gone.
    expect(DeleteAgentResponseSchema.parse({ agent })).toStrictEqual({});
  });
});

describe('AddAgentToProjectRequestSchema', () => {
  it('round-trips the project to join', () => {
    expect(AddAgentToProjectRequestSchema.parse({ projectId })).toStrictEqual({ projectId });
  });

  it('rejects an agent id where the project belongs', () => {
    expect(AddAgentToProjectRequestSchema.safeParse({ projectId: agentId }).success).toBe(false);
  });

  it('rejects a slug: membership is by identifier', () => {
    expect(AddAgentToProjectRequestSchema.safeParse({ projectId: 'payments' }).success).toBe(false);
  });
});

describe('AddAgentToProjectResponseSchema and RemoveAgentFromProjectResponseSchema', () => {
  it('both carry no fields', () => {
    expect(AddAgentToProjectResponseSchema.parse({})).toStrictEqual({});
    expect(RemoveAgentFromProjectResponseSchema.parse({})).toStrictEqual({});
  });
});
