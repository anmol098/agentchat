import { describe, expect, it } from 'vitest';

import { AgentId, ProjectId, UserId } from '../ids.js';
import {
  CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  GetProjectResponseSchema,
  LeaveProjectRequestSchema,
  LeaveProjectResponseSchema,
  ListProjectAgentsResponseSchema,
  ListProjectsResponseSchema,
  ProjectIdParamsSchema,
} from './projects.js';

const userId = UserId.generate();
const projectId = ProjectId.generate();
const agentId = AgentId.generate();

const membership = {
  id: projectId,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: userId,
  createdAt: '2026-09-08T12:00:00.000Z',
  role: 'owner' as const,
};

describe('ProjectIdParamsSchema', () => {
  it('parses a project id out of the path', () => {
    expect(ProjectIdParamsSchema.parse({ id: projectId })).toStrictEqual({ id: projectId });
  });

  it('rejects an agent id in the project slot', () => {
    // A path segment of the wrong kind is a BAD_REQUEST at the boundary, not a
    // lookup that happens to miss.
    expect(ProjectIdParamsSchema.safeParse({ id: agentId }).success).toBe(false);
  });

  it('rejects a bare uuid and a slug', () => {
    for (const id of ['018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b', 'payments', '']) {
      expect(ProjectIdParamsSchema.safeParse({ id }).success).toBe(false);
    }
  });

  it('yields a branded id a handler cannot misuse', () => {
    const { id } = ProjectIdParamsSchema.parse({ id: projectId });
    // Compile-time half of the assertion: this must not be assignable to an
    // AgentId. `pnpm typecheck` is what actually runs it.
    // @ts-expect-error - a ProjectId is not an AgentId.
    const wrong: ReturnType<typeof AgentId.generate> = id;
    expect(wrong).toBe(projectId);
  });
});

describe('ListProjectsResponseSchema', () => {
  it('round-trips a list of memberships', () => {
    expect(ListProjectsResponseSchema.parse([membership])).toStrictEqual([membership]);
  });

  it('accepts an empty list', () => {
    expect(ListProjectsResponseSchema.parse([])).toStrictEqual([]);
  });

  it('is a bare array, not an envelope', () => {
    // Plan section 3 writes the one list response it specifies as a bare array;
    // every M1 list follows it. See the module note for the cost.
    expect(ListProjectsResponseSchema.safeParse({ projects: [membership] }).success).toBe(false);
  });

  it('rejects a member row that lost its role', () => {
    const { role: _omitted, ...withoutRole } = membership;
    expect(ListProjectsResponseSchema.safeParse([withoutRole]).success).toBe(false);
  });
});

describe('CreateProjectRequestSchema', () => {
  it('accepts a name alone and leaves the slug to the server', () => {
    expect(CreateProjectRequestSchema.parse({ name: 'Payments Platform' })).toStrictEqual({
      name: 'Payments Platform',
    });
  });

  it('round-trips an explicit slug', () => {
    const request = { name: 'Payments Platform', slug: 'payments' };
    expect(CreateProjectRequestSchema.parse(request)).toStrictEqual(request);
  });

  it('rejects a slug outside the grammar rather than repairing it', () => {
    // The caller may be about to commit this slug to .agentchat/config.json
    // (D12), so a silent near-miss would resolve to the wrong project.
    for (const slug of ['Payments Platform', 'payments/platform', '-payments', '']) {
      expect(CreateProjectRequestSchema.safeParse({ name: 'x', slug }).success).toBe(false);
    }
  });

  it('rejects a missing or empty name', () => {
    expect(CreateProjectRequestSchema.safeParse({}).success).toBe(false);
    expect(CreateProjectRequestSchema.safeParse({ name: '' }).success).toBe(false);
  });
});

describe('CreateProjectResponseSchema and GetProjectResponseSchema', () => {
  it('both round-trip a project with the caller-s role', () => {
    expect(CreateProjectResponseSchema.parse(membership)).toStrictEqual(membership);
    expect(GetProjectResponseSchema.parse(membership)).toStrictEqual(membership);
  });

  it('reject a role outside the two the protocol defines', () => {
    expect(GetProjectResponseSchema.safeParse({ ...membership, role: 'admin' }).success).toBe(
      false,
    );
  });
});

describe('LeaveProjectRequestSchema and LeaveProjectResponseSchema', () => {
  it('carry no fields in either direction', () => {
    expect(LeaveProjectRequestSchema.parse({})).toStrictEqual({});
    expect(LeaveProjectResponseSchema.parse({})).toStrictEqual({});
  });

  it('keep room for a field a later release adds', () => {
    expect(LeaveProjectResponseSchema.parse({ remainingMembers: 2 })).toStrictEqual({});
  });
});

describe('ListProjectAgentsResponseSchema', () => {
  const row = {
    agent: {
      id: agentId,
      userId,
      name: 'backend',
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T12:00:00.000Z',
    },
    owner: { id: userId, username: 'alice', displayName: 'Alice' },
    online: true,
    sessions: 2,
  };

  it('round-trips the discovery listing plan section 3 specifies', () => {
    expect(ListProjectAgentsResponseSchema.parse([row])).toStrictEqual([row]);
  });

  it('accepts a project where nobody is listening', () => {
    const offline = { ...row, online: false, sessions: 0 };
    expect(ListProjectAgentsResponseSchema.parse([offline])).toStrictEqual([offline]);
  });

  it('rejects a row missing its presence fields', () => {
    const { online: _online, ...withoutOnline } = row;
    expect(ListProjectAgentsResponseSchema.safeParse([withoutOnline]).success).toBe(false);
  });
});
