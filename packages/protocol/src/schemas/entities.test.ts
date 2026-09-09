import { describe, expect, it } from 'vitest';

import { AgentId, ProjectId, UserId } from '../ids.js';
import {
  AgentSchema,
  PROJECT_ROLES,
  ProjectAgentSchema,
  ProjectMembershipSchema,
  ProjectRoleSchema,
  ProjectSchema,
  UserSchema,
  UserSummarySchema,
} from './entities.js';
import { MAX_RUNTIME_LENGTH } from './sessions.js';

const userId = UserId.generate();
const projectId = ProjectId.generate();
const agentId = AgentId.generate();

const userSummary = {
  id: userId,
  username: 'alice',
  displayName: 'Alice',
};

const user = {
  ...userSummary,
  email: 'alice@example.com',
  createdAt: '2026-09-08T12:00:00.000Z',
};

const project = {
  id: projectId,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: userId,
  createdAt: '2026-09-08T12:00:00.000Z',
};

const agent = {
  id: agentId,
  userId,
  name: 'backend',
  createdAt: '2026-09-08T12:00:00.000Z',
  updatedAt: '2026-09-08T12:30:00.000Z',
};

describe('ProjectRoleSchema', () => {
  it('round-trips both roles', () => {
    expect(ProjectRoleSchema.parse('owner')).toBe('owner');
    expect(ProjectRoleSchema.parse('member')).toBe('member');
  });

  it('rejects anything else, including case variants', () => {
    for (const value of ['Owner', 'admin', 'guest', '', null]) {
      expect(ProjectRoleSchema.safeParse(value).success).toBe(false);
    }
  });

  it('exposes exactly those two roles, frozen', () => {
    expect([...PROJECT_ROLES]).toStrictEqual(['owner', 'member']);
    expect(Object.isFrozen(PROJECT_ROLES)).toBe(true);
  });
});

describe('UserSummarySchema', () => {
  it('round-trips what one user may see about another', () => {
    expect(UserSummarySchema.parse(userSummary)).toStrictEqual(userSummary);
  });

  it('drops an email that leaked into the payload', () => {
    // The invite preview answers a caller who is a member of nothing. If a
    // service ever hands this schema a full user row, the contact address must
    // not survive the trip.
    const parsed = UserSummarySchema.parse({ ...userSummary, email: 'alice@example.com' });
    expect(parsed).toStrictEqual(userSummary);
    expect(parsed).not.toHaveProperty('email');
  });

  it('rejects a bare string where a branded user id belongs', () => {
    expect(UserSummarySchema.safeParse({ ...userSummary, id: 'alice' }).success).toBe(false);
  });

  it('rejects another kind of identifier', () => {
    // The whole reason the ids are branded: a project id must not pass here.
    expect(UserSummarySchema.safeParse({ ...userSummary, id: projectId }).success).toBe(false);
  });

  it('rejects a username that would make a handle ambiguous', () => {
    expect(UserSummarySchema.safeParse({ ...userSummary, username: 'Alice' }).success).toBe(false);
    expect(UserSummarySchema.safeParse({ ...userSummary, username: 'a/b' }).success).toBe(false);
  });
});

describe('UserSchema', () => {
  it('round-trips the caller-s own account', () => {
    expect(UserSchema.parse(user)).toStrictEqual(user);
  });

  it('accepts an explicit null email', () => {
    // A GitHub account with a private address is the common case.
    const withoutEmail = { ...user, email: null };
    expect(UserSchema.parse(withoutEmail)).toStrictEqual(withoutEmail);
  });

  it('requires the email key even when there is no address', () => {
    // A key that is sometimes missing and sometimes null is two shapes for one
    // fact, and every consumer then has to handle both.
    const { email: _omitted, ...withoutKey } = user;
    expect(UserSchema.safeParse(withoutKey).success).toBe(false);
  });

  it('rejects a malformed email', () => {
    expect(UserSchema.safeParse({ ...user, email: 'not-an-address' }).success).toBe(false);
  });

  it('rejects a timestamp with an offset', () => {
    expect(UserSchema.safeParse({ ...user, createdAt: '2026-09-08T12:00:00+01:00' }).success).toBe(
      false,
    );
  });

  it('does not carry the identity provider-s own id', () => {
    // D4 keeps the protocol identity-provider agnostic; a GitHub numeric id is
    // a detail of the reference deployment.
    expect(UserSchema.parse({ ...user, githubId: 12345 })).not.toHaveProperty('githubId');
  });
});

describe('ProjectSchema', () => {
  it('round-trips a project', () => {
    expect(ProjectSchema.parse(project)).toStrictEqual(project);
  });

  it('carries no role, so it is safe to show a non-member', () => {
    expect(ProjectSchema.parse({ ...project, role: 'owner' })).not.toHaveProperty('role');
  });

  it('rejects an agent id in createdBy', () => {
    expect(ProjectSchema.safeParse({ ...project, createdBy: agentId }).success).toBe(false);
  });

  it('rejects a slug outside the grammar', () => {
    expect(ProjectSchema.safeParse({ ...project, slug: 'Payments Platform' }).success).toBe(false);
  });
});

describe('ProjectMembershipSchema', () => {
  it('round-trips a project plus the caller-s role', () => {
    const membership = { ...project, role: 'member' as const };
    expect(ProjectMembershipSchema.parse(membership)).toStrictEqual(membership);
  });

  it('requires the role, so a membership cannot silently lose it', () => {
    expect(ProjectMembershipSchema.safeParse(project).success).toBe(false);
  });
});

describe('AgentSchema', () => {
  it('round-trips an agent', () => {
    expect(AgentSchema.parse(agent)).toStrictEqual(agent);
  });

  it('rejects a project id where the owning user belongs', () => {
    expect(AgentSchema.safeParse({ ...agent, userId: projectId }).success).toBe(false);
  });

  it('rejects a name outside the plan-s grammar', () => {
    for (const name of ['Backend', 'back end', '', 'a'.repeat(33)]) {
      expect(AgentSchema.safeParse({ ...agent, name }).success).toBe(false);
    }
  });

  it('does not expose the soft-delete marker', () => {
    // D13 is how the server keeps historical messages resolvable. What a client
    // needs is the AGENT_DELETED code, which it already has.
    expect(AgentSchema.parse({ ...agent, deletedAt: null })).not.toHaveProperty('deletedAt');
  });
});

describe('ProjectAgentSchema', () => {
  const row = {
    agent,
    owner: userSummary,
    online: true,
    sessions: 2,
    runtimes: ['claude-code', 'codex'],
  };

  it('round-trips one row of discovery', () => {
    expect(ProjectAgentSchema.parse(row)).toStrictEqual(row);
  });

  it('accepts an offline agent with no sessions', () => {
    const offline = { ...row, online: false, sessions: 0, runtimes: [] };
    expect(ProjectAgentSchema.parse(offline)).toStrictEqual(offline);
  });

  it('carries the runtime beside the presence, never inside the agent', () => {
    // PRD §3.4: the runtime is metadata and an agent survives changing it. A
    // client that read `parsed.agent.runtime` would be treating a harness as
    // part of an identity that outlives it, so there must be nothing there to
    // read.
    const parsed = ProjectAgentSchema.parse(row);

    expect(parsed.runtimes).toStrictEqual(['claude-code', 'codex']);
    expect(parsed.agent).not.toHaveProperty('runtime');
    expect(parsed.agent).not.toHaveProperty('runtimes');
  });

  it('fills in an empty list when a peer omits the key entirely', () => {
    // The additive-only rule (§12.4) is why the field is defaulted rather than
    // required: a server that predates it is still a server this schema parses.
    // The default is what stops every consumer having to tell "no key" apart
    // from "no runtimes", which are the same fact.
    const { runtimes: _absent, ...withoutRuntimes } = row;

    expect(ProjectAgentSchema.parse(withoutRuntimes).runtimes).toStrictEqual([]);
  });

  it('passes an unfamiliar runtime through, and rejects an unusable one', () => {
    // D14 forbids the server interpreting a runtime, so the contract may not
    // enumerate them either: a harness released tomorrow has to survive this
    // schema. What it does police is storability — the bounds of the
    // `sessions_runtime_present_if_set` check — because a value outside them
    // could not have come from a session row.
    expect(ProjectAgentSchema.parse({ ...row, runtimes: ['Harness9000'] }).runtimes).toStrictEqual([
      'Harness9000',
    ]);

    for (const runtimes of [[''], ['x'.repeat(MAX_RUNTIME_LENGTH + 1)], ['codex', 42], 'codex']) {
      expect(ProjectAgentSchema.safeParse({ ...row, runtimes }).success).toBe(false);
    }
  });

  it('rejects a negative session count', () => {
    expect(ProjectAgentSchema.safeParse({ ...row, sessions: -1 }).success).toBe(false);
  });

  it('rejects a truthy string where the online flag belongs', () => {
    expect(ProjectAgentSchema.safeParse({ ...row, online: 'true' }).success).toBe(false);
  });

  it('shows the owner in the narrow shape, without their email', () => {
    const parsed = ProjectAgentSchema.parse({
      ...row,
      owner: { ...userSummary, email: 'alice@example.com' },
    });
    expect(parsed.owner).not.toHaveProperty('email');
  });
});
