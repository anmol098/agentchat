import { describe, expect, it } from 'vitest';

import { AgentId, InviteId, ProjectId, UserId } from '../ids.js';
import {
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  InviteCodeParamsSchema,
  InvitePreviewResponseSchema,
  JoinProjectRequestSchema,
  JoinProjectResponseSchema,
  ProjectInviteParamsSchema,
  RevokeInviteResponseSchema,
} from './invites.js';

const userId = UserId.generate();
const projectId = ProjectId.generate();
const inviteId = InviteId.generate();

const project = {
  id: projectId,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: userId,
  createdAt: '2026-09-08T12:00:00.000Z',
};

const invitedBy = { id: userId, username: 'alice', displayName: 'Alice' };

describe('InviteCodeParamsSchema', () => {
  it('parses the code out of the path', () => {
    expect(InviteCodeParamsSchema.parse({ code: 'ANET-7K4M-Q2P9' })).toStrictEqual({
      code: 'ANET-7K4M-Q2P9',
    });
  });

  it('rejects a code that could not be a path segment', () => {
    for (const code of ['', 'ANET/7K4M', '../projects']) {
      expect(InviteCodeParamsSchema.safeParse({ code }).success).toBe(false);
    }
  });
});

describe('CreateInviteRequestSchema', () => {
  it('takes no fields, because expiry and use limits are server policy', () => {
    expect(CreateInviteRequestSchema.parse({})).toStrictEqual({});
  });

  it('ignores expiry a client tried to choose for itself', () => {
    // Plan section 3 fixes the policy in prose: 7 days, unlimited uses,
    // revocable. `expiresIn` and `maxUses` are the obvious future fields, and
    // dropping them today is what lets them be added without a version bump.
    expect(CreateInviteRequestSchema.parse({ expiresIn: 60, maxUses: 1 })).toStrictEqual({});
  });
});

describe('CreateInviteResponseSchema', () => {
  const response = {
    id: inviteId,
    code: 'ANET-7K4M-Q2P9',
    expiresAt: '2026-09-15T12:00:00.000Z',
  };

  it('round-trips the identifier, the code and the expiry', () => {
    expect(CreateInviteResponseSchema.parse(response)).toStrictEqual(response);
  });

  it('carries the identifier, which is the only place one is ever disclosed', () => {
    // Nothing in M1 lists invites, so a caller who drops this field has no way
    // to revoke the code it just minted. It is not a second credential: it
    // cannot be redeemed, and the revoke route asserts project membership.
    expect(CreateInviteResponseSchema.parse(response).id).toBe(inviteId);
  });

  it('rejects an identifier of the wrong kind, so a project id cannot stand in', () => {
    expect(CreateInviteResponseSchema.safeParse({ ...response, id: projectId }).success).toBe(
      false,
    );
  });

  it('still parses a response from a server that predates the revoke route', () => {
    // `id` is optional so that adding it stays additive under plan section
    // 12.4: a required new property is a narrowing of a shipped response, and
    // an older server sends only these two fields.
    const { code, expiresAt } = response;
    expect(CreateInviteResponseSchema.parse({ code, expiresAt })).toStrictEqual({
      code,
      expiresAt,
    });
  });

  it('requires an expiry, so a code can never look permanent', () => {
    expect(CreateInviteResponseSchema.safeParse({ code: response.code }).success).toBe(false);
    expect(CreateInviteResponseSchema.safeParse({ ...response, expiresAt: null }).success).toBe(
      false,
    );
  });
});

describe('ProjectInviteParamsSchema', () => {
  it('parses both identifiers out of the path', () => {
    expect(ProjectInviteParamsSchema.parse({ id: projectId, inviteId })).toStrictEqual({
      id: projectId,
      inviteId,
    });
  });

  it('keeps the two kinds apart, so a swapped path is a BAD_REQUEST', () => {
    expect(ProjectInviteParamsSchema.safeParse({ id: inviteId, inviteId: projectId }).success).toBe(
      false,
    );
  });

  it('rejects an identifier of a third kind in the invite position', () => {
    expect(
      ProjectInviteParamsSchema.safeParse({ id: projectId, inviteId: AgentId.generate() }).success,
    ).toBe(false);
  });

  it('requires both halves', () => {
    expect(ProjectInviteParamsSchema.safeParse({ id: projectId }).success).toBe(false);
    expect(ProjectInviteParamsSchema.safeParse({ inviteId }).success).toBe(false);
  });
});

describe('RevokeInviteResponseSchema', () => {
  it('answers with no fields: the invite-s only new property is that it is gone', () => {
    expect(RevokeInviteResponseSchema.parse({})).toStrictEqual({});
  });

  it('strips anything a later server adds, so revoking twice cannot start differing', () => {
    // Revocation is idempotent, and the wire must not grow a field that lets a
    // client tell the first call from the second.
    expect(
      RevokeInviteResponseSchema.parse({ revokedAt: '2026-09-09T00:00:00.000Z' }),
    ).toStrictEqual({});
  });
});

describe('InvitePreviewResponseSchema', () => {
  const preview = { project, invitedBy };

  it('round-trips the confirmation PRD section 27 prints before joining', () => {
    expect(InvitePreviewResponseSchema.parse(preview)).toStrictEqual(preview);
  });

  it('shows the project without a role, since the caller is not a member yet', () => {
    const parsed = InvitePreviewResponseSchema.parse({
      project: { ...project, role: 'owner' },
      invitedBy,
    });
    expect(parsed.project).not.toHaveProperty('role');
  });

  it('never leaks the inviter-s email to a caller who has joined nothing', () => {
    const parsed = InvitePreviewResponseSchema.parse({
      project,
      invitedBy: { ...invitedBy, email: 'alice@example.com' },
    });
    expect(parsed.invitedBy).not.toHaveProperty('email');
  });

  it('requires both halves of the preview', () => {
    expect(InvitePreviewResponseSchema.safeParse({ project }).success).toBe(false);
    expect(InvitePreviewResponseSchema.safeParse({ invitedBy }).success).toBe(false);
  });
});

describe('JoinProjectRequestSchema and JoinProjectResponseSchema', () => {
  it('takes nothing and answers with the project just joined', () => {
    const response = { project: { ...project, role: 'member' as const } };
    expect(JoinProjectRequestSchema.parse({})).toStrictEqual({});
    expect(JoinProjectResponseSchema.parse(response)).toStrictEqual(response);
  });

  it('requires the role, so the CLI knows at once what it may do next', () => {
    expect(JoinProjectResponseSchema.safeParse({ project }).success).toBe(false);
  });

  it('is wrapped, so a later release can report what else joining did', () => {
    expect(JoinProjectResponseSchema.safeParse({ ...project, role: 'member' }).success).toBe(false);
  });
});
