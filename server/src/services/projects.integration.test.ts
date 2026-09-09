/**
 * Project agent discovery against a real PostgreSQL database.
 *
 * `./projects.test.ts` covers the slug rules, which are pure functions. This
 * suite covers the one thing in the module that is not this repository's code
 * at all: the aggregate behind `listAgents`. Every claim it makes is the
 * engine's — that `array_agg` over no rows is null rather than empty, that
 * `distinct` collapses two listeners on one harness, that a `filter` is what
 * keeps a null `runtime` out of the array instead of putting a null *in* it —
 * and a stub would only prove that the test and the code agree about a query
 * neither of them runs.
 *
 * ## Why the runtimes are worth their own suite
 *
 * `runtimes` is the one field here whose wrong answers are all quiet ones. A
 * missing `filter` produces `[null]`, which fails the contract's parse at the
 * boundary and reads as a server bug rather than a query bug. A missing
 * `distinct` produces `['codex', 'codex']`, which no schema rejects and which
 * looks exactly like a fact. A missing `coalesce` produces null for precisely
 * the agents nobody is running, which is the common case in an idle project and
 * the one a happy-path test never reaches. So each of the three is asserted
 * separately, against a database, rather than being read off the SQL.
 *
 * The suite owns a freshly created database, for the reason the other
 * integration suites give: they share one server, and rows written here must
 * not disturb another's.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentId,
  type ListProjectAgentsResponse,
  MachineId,
  ProjectId,
  SessionId,
  UserId,
} from '@agentchat/protocol';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects, users } from '../db/schema/identity.js';
import { machines, sessions } from '../db/schema/messaging.js';
import { createAuthorizationService } from './authorization.js';
import { createProjectService, type ProjectDatabase, type ProjectService } from './projects.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const schema = { users, projects, projectMembers, agents, agentProjects, machines, sessions };

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
let service: ProjectService;

/** Counts the statements one call issues, for the one-round-trip claim. */
let statements = 0;

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

/**
 * Creates a user.
 *
 * @param handle - Becomes the GitHub login, so it must match the schema's
 *   lowercase grammar.
 * @returns The new user's identifier.
 */
async function createUser(handle: string): Promise<UserId> {
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
 * @param owner - Who creates it and owns it.
 * @returns The new project's identifier.
 */
async function createProject(owner: UserId): Promise<ProjectId> {
  const id = ProjectId.generate();
  const slug = `p-${unique()}`;

  await db.insert(projects).values({ id, slug, name: slug, createdBy: owner });
  await db.insert(projectMembers).values({ projectId: id, userId: owner, role: 'owner' });

  return id;
}

/**
 * Creates an agent and joins it to a project.
 *
 * @param owner - Who owns it.
 * @param projectId - The project it participates in.
 * @param name - Its name, which orders the discovery listing.
 * @returns The new agent's identifier.
 */
async function createAgent(owner: UserId, projectId: ProjectId, name: string): Promise<AgentId> {
  const id = AgentId.generate();

  await db.insert(agents).values({ id, userId: owner, name });
  await db.insert(agentProjects).values({ agentId: id, projectId });

  return id;
}

/**
 * Registers a listener: one `agentchat listen` process, as a row.
 *
 * @param owner - Who owns the machine it runs on.
 * @param agentId - The agent the listener speaks for.
 * @param projectId - The project it is listening in.
 * @param runtime - The harness that started it, or `null` for a session
 *   written by something that did not declare one.
 * @returns The new session's identifier.
 */
async function createSession(
  owner: UserId,
  agentId: AgentId,
  projectId: ProjectId,
  runtime: string | null,
): Promise<SessionId> {
  const machineId = MachineId.generate();
  await db.insert(machines).values({ id: machineId, userId: owner, name: `m-${unique()}` });

  const id = SessionId.generate();
  await db.insert(sessions).values({
    id,
    agentId,
    projectId,
    machineId,
    runtime,
    workingDirectory: '/tmp/agentchat',
  });

  return id;
}

/** The discovery row for one agent, or `undefined` if it is not listed. */
function rowFor(
  listing: ListProjectAgentsResponse,
  agentId: AgentId,
): ListProjectAgentsResponse['items'][number] | undefined {
  return listing.items.find((item) => item.agent.id === agentId);
}

// Alice owns the project throughout; Bob is the second member, because an
// agent's runtimes must be visible to a fellow member and not only to its
// owner — that is what makes discovery discovery.
let alice: UserId;
let bob: UserId;
let alpha: ProjectId;

beforeAll(async () => {
  databaseName = `agentchat_t034_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName), max: 5 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  // The real handle in every respect except that it keeps count, so the
  // round-trip claim is measured rather than read off the source. Assembled
  // field by field rather than spread, because Drizzle's methods live on a
  // prototype and a spread would leave `transaction` behind.
  //
  // The service narrows the handle with a `Pick`; the overloads do not survive
  // being wrapped, so each shape is restated here rather than weakened in the
  // module the server depends on.
  const countingSelect = ((...args: Parameters<typeof db.select>) => {
    statements += 1;
    return db.select(...args);
  }) as typeof db.select;

  const counting: ProjectDatabase<typeof schema> = {
    select: countingSelect,
    insert: db.insert.bind(db) as typeof db.insert,
    delete: db.delete.bind(db) as typeof db.delete,
    update: db.update.bind(db) as typeof db.update,
    transaction: db.transaction.bind(db) as typeof db.transaction,
  };

  service = createProjectService({
    db: counting,
    authorization: createAuthorizationService({ select: countingSelect }),
  });
}, 60_000);

afterAll(async () => {
  await pool.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

beforeEach(async () => {
  alice = await createUser('alice');
  bob = await createUser('bob');
  alpha = await createProject(alice);
  await db.insert(projectMembers).values({ projectId: alpha, userId: bob, role: 'member' });
  statements = 0;
});

describe('listAgents reports the runtimes behind the presence', () => {
  it('lists both harnesses for an agent listening from two of them', async () => {
    const agentId = await createAgent(alice, alpha, 'backend');
    await createSession(alice, agentId, alpha, 'claude-code');
    await createSession(alice, agentId, alpha, 'codex');

    const row = rowFor(await service.listAgents(bob, alpha), agentId);

    expect(row).toMatchObject({ online: true, sessions: 2 });
    // Sorted, because the query says `order by` and a caller renders this.
    expect(row?.runtimes).toStrictEqual(['claude-code', 'codex']);
  });

  it('reports an agent nobody is running as online: false with no runtimes', async () => {
    const agentId = await createAgent(alice, alpha, 'frontend');

    const row = rowFor(await service.listAgents(bob, alpha), agentId);

    // An empty array rather than a null or an absent key: `array_agg` over no
    // rows is null, and the `coalesce` is what turns that into the shape the
    // contract accepts.
    expect(row).toMatchObject({ online: false, sessions: 0, runtimes: [] });
  });

  it('collapses two listeners on one harness into one runtime', async () => {
    // The count and the runtime list answer different questions, and this is
    // where they diverge: two sessions, one harness. Without `distinct` this
    // would read as `['codex', 'codex']`, which no schema rejects and which
    // looks exactly like a fact.
    const agentId = await createAgent(alice, alpha, 'research');
    await createSession(alice, agentId, alpha, 'codex');
    await createSession(alice, agentId, alpha, 'codex');

    const row = rowFor(await service.listAgents(bob, alpha), agentId);

    expect(row?.sessions).toBe(2);
    expect(row?.runtimes).toStrictEqual(['codex']);
  });

  it('leaves out a session that declared no runtime, without leaving a hole', async () => {
    // `sessions.runtime` is nullable — plan §2 marks it optional so the column
    // accepts a row written by something that is not today's CLI, which D14
    // requires `--runtime` of. Such a session is still presence; it just has no
    // harness to report, and a null inside the array would be a claim of one.
    const agentId = await createAgent(alice, alpha, 'ops');
    await createSession(alice, agentId, alpha, null);
    await createSession(alice, agentId, alpha, 'opencode');

    const row = rowFor(await service.listAgents(bob, alpha), agentId);

    expect(row?.sessions).toBe(2);
    expect(row?.runtimes).toStrictEqual(['opencode']);
  });

  it('reports no runtimes at all when every session declared none', async () => {
    const agentId = await createAgent(alice, alpha, 'legacy');
    await createSession(alice, agentId, alpha, null);

    const row = rowFor(await service.listAgents(bob, alpha), agentId);

    // Online, and nothing known about what is running it. The absence of a
    // claim, not a claim of absence.
    expect(row).toMatchObject({ online: true, sessions: 1, runtimes: [] });
  });

  it('ignores a session that is no longer active', async () => {
    // Presence is "at least one `active` session" (plan §2), and the runtimes
    // are the harnesses *behind that presence*. A stale listener reporting a
    // runtime would say an agent is reachable through a harness that has
    // stopped answering.
    const agentId = await createAgent(alice, alpha, 'sweeper');
    const staleId = await createSession(alice, agentId, alpha, 'claude-code');
    await db.update(sessions).set({ status: 'stale' }).where(eq(sessions.id, staleId));

    const row = rowFor(await service.listAgents(bob, alpha), agentId);

    expect(row).toMatchObject({ online: false, sessions: 0, runtimes: [] });
  });

  it('ignores a session the same agent holds in another project', async () => {
    // Discovery answers about one project. An agent listening in `beta` is not
    // reachable in `alpha`, and its harness is not `alpha`'s business either.
    const beta = await createProject(alice);
    const agentId = await createAgent(alice, alpha, 'shared');
    await db.insert(agentProjects).values({ agentId, projectId: beta });
    await createSession(alice, agentId, beta, 'codex');

    const row = rowFor(await service.listAgents(bob, alpha), agentId);

    expect(row).toMatchObject({ online: false, sessions: 0, runtimes: [] });
  });

  it('discloses no machine name anywhere in a row', async () => {
    // PRD §21 lists the owner, the name, the status and optional runtime
    // metadata. A hostname is none of those, and it would be the first thing
    // here that tells one member which host another member's agent runs on.
    const agentId = await createAgent(alice, alpha, 'private');
    const machineId = MachineId.generate();
    await db.insert(machines).values({ id: machineId, userId: alice, name: 'alices-laptop' });
    const sessionId = SessionId.generate();
    await db.insert(sessions).values({
      id: sessionId,
      agentId,
      projectId: alpha,
      machineId,
      runtime: 'claude-code',
      workingDirectory: '/home/alice/secret-project',
    });

    const listing = await service.listAgents(bob, alpha);

    const serialised = JSON.stringify(listing);
    expect(serialised).not.toContain('alices-laptop');
    expect(serialised).not.toContain(machineId);
    expect(serialised).not.toContain('secret-project');
  });

  it('passes an unfamiliar harness through untouched (D14)', async () => {
    // The server does not interpret a runtime any more than it interprets
    // message content. A harness released after this build has to survive the
    // round trip with its own spelling intact.
    const agentId = await createAgent(alice, alpha, 'future');
    await createSession(alice, agentId, alpha, 'Harness9000');

    const row = rowFor(await service.listAgents(bob, alpha), agentId);

    expect(row?.runtimes).toStrictEqual(['Harness9000']);
  });

  it('still costs two statements with twenty agents on forty sessions', async () => {
    // The membership assertion and the listing, whatever the project's size.
    // The runtimes fold into the aggregate the listing already computes, so
    // adding them must not turn discovery into one round trip per agent — the
    // failure this assertion exists to catch, and one that is invisible in a
    // project with three agents in it.
    for (let index = 0; index < 20; index += 1) {
      const agentId = await createAgent(alice, alpha, `bulk-${index}`);
      await createSession(alice, agentId, alpha, 'claude-code');
      await createSession(alice, agentId, alpha, 'codex');
    }

    statements = 0;
    const listing = await service.listAgents(bob, alpha);

    expect(listing.items).toHaveLength(20);
    expect(statements).toBe(2);
    for (const item of listing.items) {
      expect(item.runtimes).toStrictEqual(['claude-code', 'codex']);
    }
  });
});
