/**
 * `GET /sessions` end to end: a real Fastify instance, the real authentication
 * guard, the real session service, and a real PostgreSQL.
 *
 * The property this suite exists for is one sentence, and it cannot be
 * established anywhere else:
 *
 * > **A caller sees their own sessions and nobody else's, whatever they ask
 * > for.**
 *
 * Not "is not shown them" — cannot obtain them, with a valid token, a correct
 * `agt_` id belonging to somebody else, and full membership of the project
 * their listener runs in. The scoping is a join on `agents.user_id` inside the
 * statement, so a stub service could be made to say anything and only the
 * database can prove it.
 *
 * ## Why this endpoint gets its own integration suite rather than trusting the
 * service one
 *
 * `services/sessions.integration.test.ts` already proves the query is scoped.
 * What it cannot prove is that the *endpoint* discloses nothing further: a
 * route is where an id becomes a URL, where a refusal becomes a status code,
 * and where a leak would take the shape of an error message rather than a row.
 * T-106 settled that a caller who may not see a thing is told it does not
 * exist, and this listing is the sharper case — an agent id is printed by every
 * discovery listing, so `403` on a stranger's would turn the diagnostics
 * endpoint into an oracle for which of those ids are real. The assertions below
 * are therefore about the whole response: the status, the envelope, and the
 * absence of another user's machine name anywhere in the payload.
 *
 * Machine names are the reason that last one is checked as a string search
 * rather than as a field. A hostname is `alices-mbp`; a working directory is
 * `/Users/alice/src/payments`. Between them they say who somebody is, where
 * they work and on what, which is worse to leak than the identifier that would
 * merely confirm an agent exists.
 *
 * The suite owns a freshly created database, for the reason the other
 * integration suites give: they share one server, and rows written here must
 * not disturb another's.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentId,
  type AgentId as AgentIdType,
  ProjectId,
  type ProjectId as ProjectIdType,
  type SessionSummary,
  UserId,
  type UserId as UserIdType,
} from '@stackgrid/protocol';
import { eq, sql } from 'drizzle-orm';
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
import { projectMembers, projects, users } from '../db/schema/identity.js';
import {
  conversations,
  deliveries,
  machines,
  messageInbox,
  messages,
  sessions,
} from '../db/schema/messaging.js';
import { registerAuth } from '../plugins/auth.js';
import { createAuthorizationService } from '../services/authorization.js';
import {
  createSessionService,
  HEARTBEAT_TIMEOUT_SECONDS,
  type SessionService,
} from '../services/sessions.js';
import type { HealthProbe } from './health.js';
import { registerSessionRoutes } from './sessions.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** The signing key both the tokens and the guard use. */
const JWT_SECRET = 'j'.repeat(32);

const schema = {
  users,
  projects,
  projectMembers,
  agents,
  agentProjects,
  machines,
  sessions,
  conversations,
  messages,
  messageInbox,
  deliveries,
};

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
let app: FastifyInstance;
let service: SessionService;

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

/**
 * Creates a project with one owner.
 *
 * Written directly rather than through `POST /projects`, because project
 * creation is another suite's subject and this one is about what happens
 * inside a project that already exists.
 *
 * @param owner - The first member.
 * @returns The new project's identifier.
 */
async function createProject(owner: UserIdType): Promise<ProjectIdType> {
  const id = ProjectId.generate();
  await db
    .insert(projects)
    .values({ id, slug: `p-${unique()}`, name: 'payments', createdBy: owner });
  await db.insert(projectMembers).values({ projectId: id, userId: owner, role: 'owner' });
  return id;
}

/**
 * Adds a member to a project.
 *
 * @param projectId - The project.
 * @param userId - The person joining.
 */
async function addMember(projectId: ProjectIdType, userId: UserIdType): Promise<void> {
  await db.insert(projectMembers).values({ projectId, userId, role: 'member' });
}

/**
 * Creates an agent and joins it to a project.
 *
 * @param owner - Who owns it.
 * @param name - Its name.
 * @param projectId - The project it participates in.
 * @returns The new agent's identifier.
 */
async function createAgent(
  owner: UserIdType,
  name: string,
  projectId: ProjectIdType,
): Promise<AgentIdType> {
  const id = AgentId.generate();
  await db.insert(agents).values({ id, userId: owner, name });
  await db.insert(agentProjects).values({ agentId: id, projectId });
  return id;
}

/** One listing, as the endpoint answers it. */
interface ListOutcome {
  /** The HTTP status. */
  readonly statusCode: number;
  /** The raw body, for asserting that a string appears nowhere in it. */
  readonly payload: string;
  /** The sessions the caller was shown. */
  readonly items: SessionSummary[];
}

/**
 * Reads the listing through `GET /sessions`.
 *
 * @param caller - The authenticated reader.
 * @param query - Optional `projectId`, `agentId` and `includeEnded`.
 * @returns The status, the raw payload, and the sessions.
 */
async function list(caller: UserIdType, query: Record<string, string> = {}): Promise<ListOutcome> {
  const search = new URLSearchParams(query).toString();

  const response = await app.inject({
    method: 'GET',
    url: `/sessions${search === '' ? '' : `?${search}`}`,
    headers: { authorization: bearer(caller) },
  });

  const parsed = JSON.parse(response.payload) as { items?: SessionSummary[] };

  return {
    statusCode: response.statusCode,
    payload: response.payload,
    items: parsed.items ?? [],
  };
}

beforeAll(async () => {
  databaseName = `agentchat_t028_${unique()}`;

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

  // The same wiring `app.ts` holds.
  service = createSessionService({ db, authorization: createAuthorizationService(db) });
  registerSessionRoutes(app, { sessions: service });

  await app.ready();
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

describe('a session the caller owns', () => {
  it('is listed with the detail a count cannot carry', async () => {
    const alice = await createUser('alice');
    const project = await createProject(alice);
    const agent = await createAgent(alice, 'backend', project);

    const registered = await service.register({
      userId: alice,
      agentId: agent,
      projectId: project,
      machineName: 'alices-mbp',
      runtime: 'claude-code',
      workingDirectory: '/Users/alice/src/payments',
    });

    const outcome = await list(alice, { projectId: project });

    expect(outcome.statusCode).toBe(200);
    expect(outcome.items).toHaveLength(1);

    // Every field T-209 named as missing from the derived count: which machine,
    // which runtime, which directory, how old, and the identifier `listen`
    // printed on stderr so the two can be matched up.
    const [session] = outcome.items;
    expect(session?.id).toBe(registered.id);
    expect(session?.agentId).toBe(agent);
    expect(session?.projectId).toBe(project);
    expect(session?.machineName).toBe('alices-mbp');
    expect(session?.runtime).toBe('claude-code');
    expect(session?.workingDirectory).toBe('/Users/alice/src/payments');
    expect(session?.status).toBe('active');
    expect(session?.endedAt).toBeNull();
    expect(Date.parse(session?.startedAt ?? '')).not.toBeNaN();
    expect(Date.parse(session?.lastSeenAt ?? '')).not.toBeNaN();
  });

  it('is reported as stale rather than dropped, which is the whole diagnostic', async () => {
    // A count says zero and stops. This says "registered, and silent", which is
    // the state a wedged listener is actually in.
    const alice = await createUser('alice');
    const project = await createProject(alice);
    const agent = await createAgent(alice, 'backend', project);

    const registered = await service.register({
      userId: alice,
      agentId: agent,
      projectId: project,
      machineName: 'alices-mbp',
      runtime: 'claude-code',
      workingDirectory: '/Users/alice/src/payments',
    });

    // Aged against the real threshold and moved by the real sweep, rather than
    // by writing the status this endpoint is supposed to report.
    await db
      .update(sessions)
      .set({ lastSeenAt: sql`now() - make_interval(secs => ${HEARTBEAT_TIMEOUT_SECONDS * 2})` })
      .where(eq(sessions.id, registered.id));
    await service.sweep();

    const outcome = await list(alice, { projectId: project });

    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]?.status).toBe('stale');
  });

  it('leaves an ended session out until it is asked for', async () => {
    const alice = await createUser('alice');
    const project = await createProject(alice);
    const agent = await createAgent(alice, 'backend', project);

    const registered = await service.register({
      userId: alice,
      agentId: agent,
      projectId: project,
      machineName: 'alices-mbp',
      runtime: 'claude-code',
      workingDirectory: '/Users/alice/src/payments',
    });
    await service.end({ userId: alice, sessionId: registered.id });

    expect((await list(alice, { projectId: project })).items).toEqual([]);

    const included = await list(alice, { projectId: project, includeEnded: 'true' });
    expect(included.items).toHaveLength(1);
    expect(included.items[0]?.status).toBe('ended');

    // `Boolean('false')` is `true`, and this is the endpoint where that would
    // silently invert a filter.
    expect((await list(alice, { projectId: project, includeEnded: 'false' })).items).toEqual([]);
  });
});

describe('a session belonging to somebody else', () => {
  it('is invisible to a fellow member of the same project', async () => {
    const alice = await createUser('alice');
    const mallory = await createUser('mallory');

    const project = await createProject(alice);
    await addMember(project, mallory);

    const alicesAgent = await createAgent(alice, 'backend', project);
    // Mallory is a full member with her own live agent in the project. Nothing
    // about her access is irregular; she simply does not own Alice's listener.
    const mallorysAgent = await createAgent(mallory, 'frontend', project);

    await service.register({
      userId: alice,
      agentId: alicesAgent,
      projectId: project,
      machineName: 'alices-mbp',
      runtime: 'claude-code',
      workingDirectory: '/Users/alice/src/payments',
    });
    await service.register({
      userId: mallory,
      agentId: mallorysAgent,
      projectId: project,
      machineName: 'mallory-desktop',
      runtime: 'codex',
      workingDirectory: '/home/mallory/work',
    });

    const outcome = await list(mallory, { projectId: project });

    expect(outcome.statusCode).toBe(200);
    expect(outcome.items).toHaveLength(1);
    expect(outcome.items[0]?.agentId).toBe(mallorysAgent);

    // Asserted against the whole payload, not against a field: a leak here
    // would be a hostname or a path, and either one says where somebody works.
    expect(outcome.payload).not.toContain('alices-mbp');
    expect(outcome.payload).not.toContain('/Users/alice/src/payments');
    expect(outcome.payload).not.toContain(alicesAgent);
  });

  it('answers an empty list for their agent id rather than refusing', async () => {
    // A refusal would confirm the identifier exists, and agent ids are printed
    // by every discovery listing. Empty and 200 discloses nothing (T-106).
    const alice = await createUser('alice');
    const mallory = await createUser('mallory');

    const project = await createProject(alice);
    await addMember(project, mallory);

    const alicesAgent = await createAgent(alice, 'backend', project);
    await service.register({
      userId: alice,
      agentId: alicesAgent,
      projectId: project,
      machineName: 'alices-mbp',
      runtime: 'claude-code',
      workingDirectory: '/Users/alice/src/payments',
    });

    const real = await list(mallory, { agentId: alicesAgent });
    const imaginary = await list(mallory, { agentId: AgentId.generate() });

    expect(real.statusCode).toBe(200);
    expect(real.items).toEqual([]);

    // The stronger claim: a real agent she may not see and one that does not
    // exist are the same answer, byte for byte.
    expect(real.payload).toBe(imaginary.payload);
  });

  it('stays invisible when the project filter is dropped entirely', async () => {
    // The filters narrow; they never widen. Asking for everything asks for
    // everything *of the caller's*.
    const alice = await createUser('alice');
    const mallory = await createUser('mallory');

    const project = await createProject(alice);
    await addMember(project, mallory);

    const alicesAgent = await createAgent(alice, 'backend', project);
    await service.register({
      userId: alice,
      agentId: alicesAgent,
      projectId: project,
      machineName: 'alices-only-laptop',
      runtime: 'claude-code',
      workingDirectory: '/Users/alice/src/secret',
    });

    const outcome = await list(mallory, { includeEnded: 'true' });

    expect(outcome.statusCode).toBe(200);
    expect(outcome.payload).not.toContain('alices-only-laptop');
    expect(outcome.payload).not.toContain('/Users/alice/src/secret');
  });
});

describe('the listing itself', () => {
  it('refuses an unauthenticated caller, like every route in this module', async () => {
    const response = await app.inject({ method: 'GET', url: '/sessions' });

    expect(response.statusCode).toBe(401);
  });
});
