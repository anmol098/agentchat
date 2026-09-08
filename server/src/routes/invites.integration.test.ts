/**
 * The invite endpoints end to end: a real Fastify instance, the real
 * authentication guard, the real authorization service, and a real PostgreSQL.
 *
 * Built like `projects.integration.test.ts`, and for the same reason —
 * everything this task has to establish is decided by the database rather than
 * by this repository:
 *
 *  - that a code minted by one member is redeemable by a stranger, and that
 *    redeeming it writes exactly one `project_members` row;
 *  - that redeeming it twice is a success rather than a `CONFLICT`, and that
 *    the second attempt consumes no use of the code;
 *  - that an expired code and a revoked code fail exactly as an invented one
 *    does — same status, same code, same bytes — which is the property that
 *    stops the preview being an oracle;
 *  - that the preview answers a caller who is a member of nothing, and answers
 *    with nothing but the project and the inviter.
 *
 * Revocation is set here by writing `revoked_at` directly. The endpoint that
 * does it belongs to T-014; what this task owes that task is a service which
 * already refuses a revoked code everywhere, and that is what these tests pin.
 *
 * The suite owns a freshly created database, for the reason the other
 * integration suites give: they share one server, and rows written here must
 * not disturb another's.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  CreateInviteResponseSchema,
  CreateProjectResponseSchema,
  ErrorCode,
  InvitePreviewResponseSchema,
  JoinProjectResponseSchema,
  ProjectId,
  type ProjectId as ProjectIdType,
  UserId,
  type UserId as UserIdType,
} from '@agentchat/protocol';
import { and, eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import pino, { type Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAppShell } from '../app.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from '../auth/tokens.js';
import { loadConfig, type ServerConfig } from '../config.js';
import { agentProjects, agents } from '../db/schema/agents.js';
import { projectInvites, projectMembers, projects, users } from '../db/schema/identity.js';
import { machines, sessions } from '../db/schema/messaging.js';
import { registerAuth } from '../plugins/auth.js';
import type { HealthProbe } from './health.js';
import { registerInviteRoutes } from './invites.js';
import { registerProjectRoutes } from './projects.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** The signing key both the tokens and the guard use. */
const JWT_SECRET = 'j'.repeat(32);

const schema = {
  users,
  projects,
  projectMembers,
  projectInvites,
  agents,
  agentProjects,
  machines,
  sessions,
};

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
let app: FastifyInstance;

/** Connection string for `databaseName` on the server `DATABASE_URL` names. */
function urlForScratchDatabase(name: string): string {
  const raw = process.env['DATABASE_URL'];
  if (raw === undefined) {
    throw new Error('DATABASE_URL is not set; the global setup should have refused to start.');
  }
  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A bearer header for a user, valid now. */
function bearer(userId: UserIdType): string {
  const iat = Math.floor(Date.now() / 1000);
  return `Bearer ${signAccessToken({ sub: userId, iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS }, JWT_SECRET)}`;
}

/**
 * Creates a user.
 *
 * @param handle - Becomes the login, so it must match the schema's grammar.
 * @returns The new user's identifier.
 */
async function createUser(handle: string): Promise<UserIdType> {
  const id = UserId.generate();

  await db.insert(users).values({
    id,
    githubId: unique(),
    username: `${handle}-${unique()}`,
    displayName: handle,
  });

  return id;
}

/** The error envelope a response carries. */
function envelopeOf(payload: string): { code: string; message: string } {
  return (JSON.parse(payload) as { error: { code: string; message: string } }).error;
}

/**
 * Creates a project through the real endpoint, so its owner membership is
 * written the way a deployment writes it.
 *
 * @param owner - Who creates it.
 * @param name - The display name.
 * @returns The new project's identifier.
 */
async function createProject(owner: UserIdType, name: string): Promise<ProjectIdType> {
  const response = await app.inject({
    method: 'POST',
    url: '/projects',
    headers: { authorization: bearer(owner) },
    payload: { name, slug: `p-${unique()}` },
  });

  expect(response.statusCode, response.payload).toBe(200);
  return ProjectId.parse(CreateProjectResponseSchema.parse(JSON.parse(response.payload)).id);
}

/**
 * Mints an invite through the endpoint.
 *
 * @param caller - Who asks for it.
 * @param projectId - The project.
 * @returns The raw response, so a test can assert on the status too.
 */
async function postInvite(
  caller: UserIdType,
  projectId: ProjectIdType,
): Promise<{ statusCode: number; payload: string }> {
  const response = await app.inject({
    method: 'POST',
    url: `/projects/${projectId}/invites`,
    headers: { authorization: bearer(caller) },
    payload: {},
  });

  return { statusCode: response.statusCode, payload: response.payload };
}

/**
 * Mints an invite and returns its code, failing loudly if minting did not
 * succeed.
 *
 * @param caller - Who asks for it.
 * @param projectId - The project.
 * @returns The code.
 */
async function inviteCode(caller: UserIdType, projectId: ProjectIdType): Promise<string> {
  const response = await postInvite(caller, projectId);
  expect(response.statusCode, response.payload).toBe(200);
  return CreateInviteResponseSchema.parse(JSON.parse(response.payload)).code;
}

/**
 * Previews a code.
 *
 * @param caller - The authenticated caller; membership is not required.
 * @param code - The code, as a user would type it.
 * @returns The raw response.
 */
async function getPreview(
  caller: UserIdType,
  code: string,
): Promise<{ statusCode: number; payload: string }> {
  const response = await app.inject({
    method: 'GET',
    url: `/invites/${code}`,
    headers: { authorization: bearer(caller) },
  });

  return { statusCode: response.statusCode, payload: response.payload };
}

/**
 * Redeems a code.
 *
 * @param caller - Who joins.
 * @param code - The code.
 * @returns The raw response.
 */
async function postJoin(
  caller: UserIdType,
  code: string,
): Promise<{ statusCode: number; payload: string }> {
  const response = await app.inject({
    method: 'POST',
    url: `/invites/${code}/join`,
    headers: { authorization: bearer(caller) },
    payload: {},
  });

  return { statusCode: response.statusCode, payload: response.payload };
}

/** The stored row for a code, for assertions about `uses` and `revoked_at`. */
async function inviteRow(code: string): Promise<{ uses: number; revokedAt: Date | null }> {
  const rows = await db
    .select({ uses: projectInvites.uses, revokedAt: projectInvites.revokedAt })
    .from(projectInvites)
    .where(eq(projectInvites.code, code));

  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No invite row for ${code}.`);
  }
  return row;
}

/** How many members a project has. */
async function memberCount(projectId: ProjectIdType): Promise<number> {
  const rows = await db
    .select({ userId: projectMembers.userId })
    .from(projectMembers)
    .where(eq(projectMembers.projectId, projectId));
  return rows.length;
}

beforeAll(async () => {
  databaseName = `agentchat_t108_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName), max: 5 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  const config: ServerConfig = loadConfig({
    DATABASE_URL: urlForScratchDatabase(databaseName),
    LOG_LEVEL: 'silent',
    JWT_SECRET,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
  });
  const logger: Logger = pino({ level: 'silent' });
  const probe: HealthProbe = { ping: () => Promise.resolve() };

  app = createAppShell({ config, database: probe, logger });
  registerAuth(app, { jwtSecret: JWT_SECRET });
  // Exactly the two lines T-023 adds to `app.ts`. The project routes are here
  // because a project has to exist before it can be invited into, and because
  // joining is only meaningful if `GET /projects` afterwards agrees.
  registerProjectRoutes(app, { db });
  registerInviteRoutes(app, { db });
});

afterAll(async () => {
  await app?.close();
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

describe('minting a code', () => {
  it('lets any member, not only an owner, create one (D11)', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Payments Platform');

    // Bob joins as a plain member, then mints a code of his own.
    const joined = await postJoin(bob, await inviteCode(alice, projectId));
    expect(joined.statusCode, joined.payload).toBe(200);
    expect(JoinProjectResponseSchema.parse(JSON.parse(joined.payload)).project.role).toBe('member');

    const minted = await postInvite(bob, projectId);
    expect(minted.statusCode, minted.payload).toBe(200);

    const invite = CreateInviteResponseSchema.parse(JSON.parse(minted.payload));
    expect(invite.code).toMatch(/^ANET-[0-9A-Z]{4}-[0-9A-Z]{4}$/);

    // Seven days, unlimited uses until then (plan §3).
    const life = new Date(invite.expiresAt).getTime() - Date.now();
    expect(life).toBeGreaterThan(6.9 * 24 * 60 * 60 * 1000);
    expect(life).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000);

    const stored = await db
      .select({ maxUses: projectInvites.maxUses, uses: projectInvites.uses })
      .from(projectInvites)
      .where(eq(projectInvites.code, invite.code));
    expect(stored[0]).toStrictEqual({ maxUses: null, uses: 0 });
  });

  it('answers a non-member exactly as a missing project would', async () => {
    const alice = await createUser('alice');
    const mallory = await createUser('mallory');
    const projectId = await createProject(alice, 'Payments Platform');

    const refused = await postInvite(mallory, projectId);
    const invented = await postInvite(mallory, ProjectId.generate());

    // Byte for byte the same. Otherwise minting is a way to ask whether a
    // project id you found in somebody's shell history is real.
    expect(refused.statusCode).toBe(404);
    expect(invented.statusCode).toBe(404);
    expect(envelopeOf(refused.payload)).toStrictEqual(envelopeOf(invented.payload));
    expect(envelopeOf(refused.payload).code).toBe(ErrorCode.NOT_FOUND);
  });

  it('mints distinct codes for the same project', async () => {
    const alice = await createUser('alice');
    const projectId = await createProject(alice, 'Payments Platform');

    const first = await inviteCode(alice, projectId);
    const second = await inviteCode(alice, projectId);
    expect(first).not.toBe(second);
  });
});

describe('previewing a code', () => {
  it('answers a caller who is a member of nothing', async () => {
    const alice = await createUser('alice');
    const stranger = await createUser('stranger');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    const response = await getPreview(stranger, code);
    expect(response.statusCode, response.payload).toBe(200);

    const preview = InvitePreviewResponseSchema.parse(JSON.parse(response.payload));
    expect(preview.project.id).toBe(projectId);
    expect(preview.project.name).toBe('Payments Platform');
    expect(preview.invitedBy.id).toBe(alice);
    expect(preview.invitedBy.displayName).toBe('alice');

    // The stranger is still a member of nothing: previewing is not joining.
    expect(await memberCount(projectId)).toBe(1);
  });

  it('discloses the project and the inviter, and nothing else', async () => {
    const alice = await createUser('alice');
    const stranger = await createUser('stranger');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    const body = JSON.parse((await getPreview(stranger, code)).payload) as Record<string, unknown>;

    // Asserted on the raw body rather than on the parsed one: zod strips
    // unknown keys, so parsing first would hide exactly the leak this checks
    // for. No members, no agents, no role, no counts, no invite identifier —
    // and no `email` on the inviter, which is why the contract embeds
    // `UserSummarySchema` rather than `UserSchema`.
    expect(Object.keys(body).sort()).toStrictEqual(['invitedBy', 'project']);
    expect(Object.keys(body['project'] as object).sort()).toStrictEqual([
      'createdAt',
      'createdBy',
      'id',
      'name',
      'slug',
    ]);
    expect(Object.keys(body['invitedBy'] as object).sort()).toStrictEqual([
      'displayName',
      'id',
      'username',
    ]);
  });

  it('accepts a code typed in the wrong case', async () => {
    const alice = await createUser('alice');
    const stranger = await createUser('stranger');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    const response = await getPreview(stranger, code.toLowerCase());
    expect(response.statusCode, response.payload).toBe(200);
    expect(InvitePreviewResponseSchema.parse(JSON.parse(response.payload)).project.id).toBe(
      projectId,
    );
  });

  it('requires a bearer token like every other route (plan §3)', async () => {
    const alice = await createUser('alice');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    // Protected by omission: this module declares no `auth: 'public'`, and
    // T-023 must not add `/invites/:code` to `PUBLIC_ROUTES`.
    const anonymous = await app.inject({ method: 'GET', url: `/invites/${code}` });
    expect(anonymous.statusCode).toBe(401);

    const anonymousJoin = await app.inject({
      method: 'POST',
      url: `/invites/${code}/join`,
      payload: {},
    });
    expect(anonymousJoin.statusCode).toBe(401);
  });
});

describe('joining', () => {
  it('makes the caller a member, and the project appears in their list', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    const response = await postJoin(bob, code);
    expect(response.statusCode, response.payload).toBe(200);

    const joined = JoinProjectResponseSchema.parse(JSON.parse(response.payload));
    expect(joined.project.id).toBe(projectId);
    // Joining never confers ownership, whoever minted the code.
    expect(joined.project.role).toBe('member');

    const listed = await app.inject({
      method: 'GET',
      url: '/projects',
      headers: { authorization: bearer(bob) },
    });
    expect(listed.statusCode).toBe(200);
    expect(JSON.parse(listed.payload)).toStrictEqual({ items: [joined.project] });

    // One row, and one use consumed.
    expect(await memberCount(projectId)).toBe(2);
    expect((await inviteRow(code)).uses).toBe(1);
  });

  it('is idempotent: joining twice is a success, and costs no second use', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    const first = await postJoin(bob, code);
    const second = await postJoin(bob, code);

    expect(second.statusCode, second.payload).toBe(200);
    expect(JSON.parse(second.payload)).toStrictEqual(JSON.parse(first.payload));

    expect(await memberCount(projectId)).toBe(2);
    // The re-join must not eat a use: with a limited code it would otherwise be
    // a way to burn somebody else's seat by retrying.
    expect((await inviteRow(code)).uses).toBe(1);
  });

  it('does not demote an owner who redeems a code for their own project', async () => {
    const alice = await createUser('alice');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    const response = await postJoin(alice, code);
    expect(response.statusCode, response.payload).toBe(200);

    // The idempotent path returns the role they have, not the role a fresh
    // redemption would grant. An `on conflict do update` here would have made
    // an owner a member by accident.
    expect(JoinProjectResponseSchema.parse(JSON.parse(response.payload)).project.role).toBe(
      'owner',
    );

    const rows = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, alice)));
    expect(rows).toStrictEqual([{ role: 'owner' }]);
  });

  it('lets several people redeem one code', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const carol = await createUser('carol');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    expect((await postJoin(bob, code)).statusCode).toBe(200);
    expect((await postJoin(carol, code)).statusCode).toBe(200);

    // Unlimited uses until expiry (plan §3).
    expect(await memberCount(projectId)).toBe(3);
    expect((await inviteRow(code)).uses).toBe(2);
  });
});

describe('a code that does not work', () => {
  /**
   * Every way a code can fail, answered to the same caller.
   *
   * @param minter - A member of the project, who mints the doomed codes.
   * @param caller - Who then tries to use them.
   * @param projectId - The project.
   * @returns Preview and join responses for an expired code, a revoked one, and
   *   one that never existed.
   */
  async function failures(
    minter: UserIdType,
    caller: UserIdType,
    projectId: ProjectIdType,
  ): Promise<Record<string, { statusCode: number; payload: string }>> {
    const expired = await inviteCode(minter, projectId);
    await db
      .update(projectInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectInvites.code, expired));

    const revoked = await inviteCode(minter, projectId);
    // Written directly: the endpoint that sets this column is T-014's. What
    // this task owes that one is a service that already refuses the row.
    await db
      .update(projectInvites)
      .set({ revokedAt: new Date() })
      .where(eq(projectInvites.code, revoked));

    const invented = 'ANET-ZZZZ-ZZZZ';

    return {
      expiredPreview: await getPreview(caller, expired),
      expiredJoin: await postJoin(caller, expired),
      revokedPreview: await getPreview(caller, revoked),
      revokedJoin: await postJoin(caller, revoked),
      inventedPreview: await getPreview(caller, invented),
      inventedJoin: await postJoin(caller, invented),
    };
  }

  it('fails identically whether it expired, was revoked, or never existed', async () => {
    const alice = await createUser('alice');
    const stranger = await createUser('stranger');
    const projectId = await createProject(alice, 'Payments Platform');

    const responses = await failures(alice, stranger, projectId);
    const reference = responses['inventedPreview'];
    if (reference === undefined) {
      throw new Error('The reference response is missing.');
    }

    for (const [name, response] of Object.entries(responses)) {
      // Same status and the same bytes, every time. A difference of any kind
      // here — a distinct code, a longer message, a different status — turns
      // the preview into an oracle: it would confirm that a guessed code was
      // once real, and a code that was once real is worth guessing again.
      expect(response.statusCode, name).toBe(404);
      expect(envelopeOf(response.payload), name).toStrictEqual(envelopeOf(reference.payload));
      expect(envelopeOf(response.payload).code, name).toBe(ErrorCode.INVITE_INVALID);
    }

    // And none of them let anybody in.
    expect(await memberCount(projectId)).toBe(1);
  });

  it('refuses a member the same way, so a bad code confirms nothing about them', async () => {
    const alice = await createUser('alice');
    const projectId = await createProject(alice, 'Payments Platform');

    // Alice is an owner of this project. A revoked code still tells her
    // nothing: were the answer different for a member, a stranger's failed
    // guess and a member's would be distinguishable.
    const responses = await failures(alice, alice, projectId);
    for (const [name, response] of Object.entries(responses)) {
      expect(response.statusCode, name).toBe(404);
      expect(envelopeOf(response.payload).code, name).toBe(ErrorCode.INVITE_INVALID);
    }
  });

  it('stops working the instant it is revoked, mid-life', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    // Works.
    expect((await getPreview(bob, code)).statusCode).toBe(200);

    await db
      .update(projectInvites)
      .set({ revokedAt: new Date() })
      .where(eq(projectInvites.code, code));

    // Does not, and does not leak that it ever did.
    const preview = await getPreview(bob, code);
    expect(preview.statusCode).toBe(404);
    expect(envelopeOf(preview.payload).code).toBe(ErrorCode.INVITE_INVALID);
    expect((await postJoin(bob, code)).statusCode).toBe(404);
    expect(await memberCount(projectId)).toBe(1);

    // The revocation is still recorded, and no use was consumed by the
    // attempts. T-014's endpoint has to be idempotent; nothing here fights it.
    const row = await inviteRow(code);
    expect(row.revokedAt).not.toBeNull();
    expect(row.uses).toBe(0);
  });

  it('refuses a code whose uses are spent', async () => {
    const alice = await createUser('alice');
    const bob = await createUser('bob');
    const carol = await createUser('carol');
    const projectId = await createProject(alice, 'Payments Platform');
    const code = await inviteCode(alice, projectId);

    // Nothing in M1 sets `max_uses` — invites are unlimited until expiry — but
    // the column exists and the guard around the increment is what stops two
    // simultaneous redemptions from both passing a limit of one.
    await db.update(projectInvites).set({ maxUses: 1 }).where(eq(projectInvites.code, code));

    expect((await postJoin(bob, code)).statusCode).toBe(200);

    const spent = await postJoin(carol, code);
    expect(spent.statusCode).toBe(404);
    expect(envelopeOf(spent.payload).code).toBe(ErrorCode.INVITE_INVALID);
    expect(await memberCount(projectId)).toBe(2);
  });

  it('rejects a code that could not be a path segment at all', async () => {
    const alice = await createUser('alice');

    // Shape, not existence: `InviteCodeSchema` accepts any run of letters,
    // digits and hyphens precisely so that a well-formed guess is answered by
    // the lookup rather than by the parser.
    const response = await getPreview(alice, 'not%20a%20code');
    expect(response.statusCode).toBe(400);
    expect(envelopeOf(response.payload).code).toBe(ErrorCode.BAD_REQUEST);
    // The code the caller sent is not echoed back into the error, and so not
    // into every log between here and them.
    expect(envelopeOf(response.payload).message).not.toContain('not a code');
  });
});
