import { describe, expect, it } from 'vitest';

import { ProjectId, UserId } from '../ids.js';
import {
  CreateInviteRequestSchema,
  CreateInviteResponseSchema,
  InviteCodeParamsSchema,
  InvitePreviewResponseSchema,
  JoinProjectRequestSchema,
  JoinProjectResponseSchema,
} from './invites.js';

const userId = UserId.generate();
const projectId = ProjectId.generate();

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
  const response = { code: 'ANET-7K4M-Q2P9', expiresAt: '2026-09-15T12:00:00.000Z' };

  it('round-trips exactly the two fields the plan names', () => {
    expect(CreateInviteResponseSchema.parse(response)).toStrictEqual(response);
  });

  it('does not carry an invite id, because no M1 endpoint accepts one', () => {
    expect(CreateInviteResponseSchema.parse({ ...response, id: 'inv_x' })).not.toHaveProperty('id');
  });

  it('requires an expiry, so a code can never look permanent', () => {
    expect(CreateInviteResponseSchema.safeParse({ code: response.code }).success).toBe(false);
    expect(CreateInviteResponseSchema.safeParse({ ...response, expiresAt: null }).success).toBe(
      false,
    );
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
