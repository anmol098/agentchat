/**
 * The session lifecycle against a real PostgreSQL database.
 *
 * `./sessions.test.ts` proves the parts that are decisions — the sweeper's
 * timer, the thresholds, the failure table. This suite proves the parts that
 * are *statements*, because every claim T-302 makes is a claim about SQL:
 *
 *  - the machine upsert produces one row for two sessions on one laptop, and
 *    survives two registrations racing each other for it;
 *  - `active` → `stale` → `ended` happens **with nobody calling `DELETE`**,
 *    which is the case that matters, since the common way a listener dies is
 *    `SIGKILL`;
 *  - the sweep is idempotent, and two sweepers running at once neither
 *    double-count nor corrupt each other;
 *  - presence, derived the way Plan §2 defines it, drops the moment a session
 *    goes stale rather than when it ends;
 *  - a caller may only register or end a session for an agent it owns, and is
 *    told the same thing about somebody else's session as about one that never
 *    existed.
 *
 * Mocking any of that would be mocking the thing under test.
 *
 * The suite owns a freshly created database, following
 * `./authorization.integration.test.ts`: integration tests share one server,
 * and rows written here must not disturb another suite's.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  AgentId,
  ErrorCode,
  ProjectId,
  ProtocolError,
  SessionId,
  UserId,
} from '@agentchat/protocol';
import { and, count, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { agentProjects, agents } from '../db/schema/agents.js';
import { projectMembers, projects, users } from '../db/schema/identity.js';
import { machines, sessions } from '../db/schema/messaging.js';
import { type ErrorResponse, toErrorResponse } from '../errors.js';
import { createAuthorizationService } from './authorization.js';
import {
  activeSessionPredicate,
  createSessionService,
  HEARTBEAT_TIMEOUT_SECONDS,
  SESSION_END_AFTER_SECONDS,
  SESSION_STATUS,
  type SessionService,
} from './sessions.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const schema = { users, projects, projectMembers, agents, agentProjects, machines, sessions };

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema>;
let databaseName: string;
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

/**
 * Creates a user.
 *
 * @param handle - Becomes the GitHub login, so it must match the lowercase grammar.
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
 * @returns The new agent's identifier.
 */
async function createAgent(owner: UserId, projectId: ProjectId): Promise<AgentId> {
  const id = AgentId.generate();
  await db.insert(agents).values({ id, userId: owner, name: `a-${unique()}` });
  await db.insert(agentProjects).values({ agentId: id, projectId });
  return id;
}

/**
 * Backdates a session's last heartbeat.
 *
 * This is how the suite drives a transition without waiting a day: the service
 * runs on its **real** thresholds — sixty seconds and
 * {@link SESSION_END_AFTER_SECONDS} — and the row is aged instead. Moving the
 * threshold rather than the row would have tested a configuration nothing
 * ships with.
 *
 * The arithmetic happens in the database, on the same clock `now()` and the
 * sweep's cutoffs use, so nothing here depends on this process's clock agreeing
 * with Postgres's.
 *
 * @param sessionId - The session to age.
 * @param seconds - How far back to move `last_seen_at`.
 */
async function ageSession(sessionId: SessionId, seconds: number): Promise<void> {
  await db
    .update(sessions)
    .set({ lastSeenAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(sessions.id, sessionId));
}

/**
 * Reads a session's row straight from the table.
 *
 * Deliberately not through the service: an assertion about what was stored
 * should not be mediated by the code that stored it.
 *
 * @param sessionId - The session.
 * @returns The row.
 */
async function rowFor(sessionId: SessionId): Promise<typeof sessions.$inferSelect> {
  const rows = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`No session row for ${sessionId}.`);
  }
  return row;
}

/**
 * Presence, computed the way Plan §2 defines it and T-401 will compute it:
 * how many `active` sessions this agent has in this project.
 *
 * Written here rather than imported from a discovery service that does not
 * exist yet, but built on {@link activeSessionPredicate} so that it is the
 * *same* definition this module exports rather than a second copy of it.
 *
 * @param agentId - The agent.
 * @param projectId - The project.
 * @returns The active session count. Online is this being above zero.
 */
async function presenceOf(agentId: AgentId, projectId: ProjectId): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(sessions)
    .where(
      and(
        eq(sessions.agentId, agentId),
        eq(sessions.projectId, projectId),
        activeSessionPredicate(),
      ),
    );
  return rows[0]?.n ?? 0;
}

/** How many machine rows this user has under this hostname. */
async function machineRowCount(userId: UserId, name: string): Promise<number> {
  const rows = await db
    .select({ n: count() })
    .from(machines)
    .where(and(eq(machines.userId, userId), eq(machines.name, name)));
  return rows[0]?.n ?? 0;
}

/**
 * Runs a call expected to fail and returns the error it threw.
 *
 * @param run - The call.
 * @returns The `ProtocolError`.
 * @throws {Error} If it did not throw, or threw something else — either is a
 *   rule that is not enforced, which must not read as a pass.
 */
async function refusal(run: () => Promise<unknown>): Promise<ProtocolError> {
  try {
    await run();
  } catch (error: unknown) {
    if (error instanceof ProtocolError) {
      return error;
    }
    throw new Error(`Expected a ProtocolError, got: ${String(error)}`);
  }
  throw new Error('Expected this call to be refused, but it succeeded.');
}

/**
 * The response a route would send for a refusal.
 *
 * @param run - The call.
 * @returns Status and envelope, through the same path a handler's throw takes.
 */
async function responseFor(run: () => Promise<unknown>): Promise<ErrorResponse> {
  return toErrorResponse(await refusal(run));
}

// The cast. Alice owns the listeners; Bob is a fellow member of the project,
// which is what makes him the interesting intruder — he can see the project and
// still may not touch her sessions.
let alice: UserId;
let bob: UserId;
let alpha: ProjectId;
let aliceAgent: AgentId;
let bobAgent: AgentId;

beforeAll(async () => {
  databaseName = `agentchat_t302_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName), max: 8 });
  db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  service = createSessionService({ db, authorization: createAuthorizationService(db) });

  alice = await createUser('alice');
  bob = await createUser('bob');
  alpha = await createProject(alice);
  await db.insert(projectMembers).values({ projectId: alpha, userId: bob, role: 'member' });

  aliceAgent = await createAgent(alice, alpha);
  bobAgent = await createAgent(bob, alpha);
});

afterAll(async () => {
  await pool?.end();

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`drop database if exists "${databaseName}" with (force)`);
  } finally {
    await admin.end();
  }
});

/**
 * Registers a listener for Alice's agent.
 *
 * @param overrides - Anything to vary; defaults are a plausible listener.
 * @returns The registered session.
 */
async function register(
  overrides: { machineName?: string; runtime?: string; workingDirectory?: string } = {},
) {
  return await service.register({
    userId: alice,
    agentId: aliceAgent,
    projectId: alpha,
    machineName: overrides.machineName ?? `mbp-${unique()}`,
    runtime: overrides.runtime ?? 'claude-code',
    workingDirectory: overrides.workingDirectory ?? '/Users/alice/src/payments',
  });
}

describe('registration', () => {
  it('records the agent, project, machine, runtime and working directory', async () => {
    const machineName = `mbp-${unique()}`;
    const session = await register({
      machineName,
      runtime: 'opencode',
      workingDirectory: '/Users/alice/src/payments',
    });

    expect(session.agentId).toBe(aliceAgent);
    expect(session.projectId).toBe(alpha);
    expect(session.machineName).toBe(machineName);
    expect(session.runtime).toBe('opencode');
    expect(session.workingDirectory).toBe('/Users/alice/src/payments');
    expect(session.status).toBe(SESSION_STATUS.ACTIVE);
    expect(session.endedAt).toBeNull();

    // Read back from the table, not from the value the service handed us.
    const row = await rowFor(session.id);
    expect(row.runtime).toBe('opencode');
    expect(row.machineId).toBe(session.machineId);
  });

  it('stores the runtime the caller gave, verbatim and uninterpreted (D14)', async () => {
    // Not a runtime this server has ever heard of, with capitals and a digit.
    // Nothing normalises it, matches it against a list, or replaces it with
    // something sniffed from the environment: the caller is the only component
    // that knows, so the caller's answer is the answer.
    const session = await register({ runtime: 'Harness9000' });
    expect((await rowFor(session.id)).runtime).toBe('Harness9000');
  });

  it('reuses one machine row for two sessions on the same laptop', async () => {
    const machineName = `laptop-${unique()}`;

    const first = await register({ machineName });
    const second = await register({ machineName });

    expect(second.machineId).toBe(first.machineId);
    expect(await machineRowCount(alice, machineName)).toBe(1);
  });

  it('survives two registrations racing for the same new machine', async () => {
    // The upsert's whole reason for being `DO UPDATE` rather than `DO NOTHING`.
    // Two `agentchat listen` invocations started together on one laptop reach
    // the insert at the same time; one conflicts, and must still learn the
    // surviving row's id from the statement that collided with it.
    const machineName = `race-${unique()}`;

    const [first, second, third] = await Promise.all([
      register({ machineName }),
      register({ machineName }),
      register({ machineName }),
    ]);

    expect(await machineRowCount(alice, machineName)).toBe(1);
    expect(second.machineId).toBe(first.machineId);
    expect(third.machineId).toBe(first.machineId);
  });

  it('gives two people the same hostname without collision', async () => {
    // `machines_user_id_name_key` is per user, not global: two people may both
    // call their laptop `mbp`, and a machine belongs to exactly one account.
    const machineName = 'mbp';

    const hers = await register({ machineName });
    const his = await service.register({
      userId: bob,
      agentId: bobAgent,
      projectId: alpha,
      machineName,
      runtime: 'codex',
      workingDirectory: '/home/bob/src',
    });

    expect(his.machineId).not.toBe(hers.machineId);
    expect(await machineRowCount(alice, machineName)).toBe(1);
    expect(await machineRowCount(bob, machineName)).toBe(1);
  });
});

describe('ownership', () => {
  it('refuses to register a session for somebody else’s agent', async () => {
    const response = await responseFor(() =>
      service.register({
        userId: bob,
        agentId: aliceAgent,
        projectId: alpha,
        machineName: `bob-${unique()}`,
        runtime: 'codex',
        workingDirectory: '/home/bob/src',
      }),
    );

    // Not 403. Bob is a member of the project and can already see the agent in
    // discovery; what he may not do is act *as* it, and `assertOwnAgentInProject`
    // is the rule that says so.
    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('refuses to end somebody else’s session', async () => {
    const hers = await register();

    const response = await responseFor(() => service.end({ userId: bob, sessionId: hers.id }));

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);

    // And it really is still running.
    expect((await rowFor(hers.id)).status).toBe(SESSION_STATUS.ACTIVE);
  });

  it('refuses to heartbeat somebody else’s session', async () => {
    const hers = await register();
    const response = await responseFor(() =>
      service.heartbeat({ userId: bob, sessionId: hers.id }),
    );

    expect(response.statusCode).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('answers a real session and an imaginary one identically', async () => {
    // The disclosure test, and the reason `requireOwnSession` translates the
    // authorization service's NOT_FOUND into its own. Session ids are printed
    // to stderr by `listen` and end up in shell history and bug reports; if
    // these envelopes differed by a byte, `DELETE /sessions/:id` would confirm
    // which ids exist.
    const hers = await register();

    const real = await responseFor(() => service.end({ userId: bob, sessionId: hers.id }));
    const imaginary = await responseFor(() =>
      service.end({ userId: bob, sessionId: SessionId.generate() }),
    );

    expect(real).toEqual(imaginary);
  });

  it('lets the owner end their own session', async () => {
    const hers = await register();
    const ended = await service.end({ userId: alice, sessionId: hers.id });

    expect(ended.status).toBe(SESSION_STATUS.ENDED);
    expect(ended.endedAt).toBeInstanceOf(Date);
  });
});

describe('the transition sequence, with nobody saying goodbye', () => {
  it('goes active, then stale, then ended, driven only by silence', async () => {
    // The case the design is built around: the process was killed without
    // warning, so `DELETE /sessions/:id` is never called and no client ever
    // heartbeats again. Nothing below touches the session except the sweep.
    const session = await register();
    const { id } = session;

    // --- active -----------------------------------------------------------
    expect(session.status).toBe(SESSION_STATUS.ACTIVE);
    expect(await presenceOf(aliceAgent, alpha)).toBeGreaterThan(0);

    const presenceWhileActive = await presenceOf(aliceAgent, alpha);

    // A sweep now moves nothing: the session heartbeated a moment ago.
    expect(await service.sweep()).toEqual({ markedStale: 0, ended: 0 });
    expect((await rowFor(id)).status).toBe(SESSION_STATUS.ACTIVE);

    // --- active -> stale --------------------------------------------------
    // One second past the sixty-second threshold. The threshold is the real
    // one; the row is what moved.
    await ageSession(id, HEARTBEAT_TIMEOUT_SECONDS + 1);

    const first = await service.sweep();
    expect(first.markedStale).toBeGreaterThanOrEqual(1);
    expect(first.ended).toBe(0);

    const stale = await rowFor(id);
    expect(stale.status).toBe(SESSION_STATUS.STALE);
    // Stale is not ended, and the schema check would not let it pretend to be.
    expect(stale.endedAt).toBeNull();

    // The property the brief calls out: stale but not ended must not report
    // the agent as online.
    expect(await presenceOf(aliceAgent, alpha)).toBe(presenceWhileActive - 1);

    // --- stale -> ended ---------------------------------------------------
    // A day of staleness, measured from `last_seen_at` the way the constant
    // documents.
    await ageSession(id, SESSION_END_AFTER_SECONDS + 1);

    const second = await service.sweep();
    expect(second.ended).toBeGreaterThanOrEqual(1);

    const ended = await rowFor(id);
    expect(ended.status).toBe(SESSION_STATUS.ENDED);
    expect(ended.endedAt).toBeInstanceOf(Date);
    expect(await presenceOf(aliceAgent, alpha)).toBe(presenceWhileActive - 1);
  });

  it('ends a session silent for longer than both thresholds in one pass', async () => {
    const session = await register();
    await ageSession(session.id, SESSION_END_AFTER_SECONDS + 60);

    const result = await service.sweep();

    expect(result.markedStale).toBeGreaterThanOrEqual(1);
    expect(result.ended).toBeGreaterThanOrEqual(1);
    expect((await rowFor(session.id)).status).toBe(SESSION_STATUS.ENDED);
  });
});

describe('the sweeper', () => {
  it('is idempotent: repeated passes move nothing and change nothing', async () => {
    const session = await register();
    await ageSession(session.id, SESSION_END_AFTER_SECONDS + 1);

    // Settle every row this suite has left lying around, so the counts below
    // are about repetition rather than about leftovers.
    await service.sweep();
    await service.sweep();

    const settled = await rowFor(session.id);
    expect(settled.status).toBe(SESSION_STATUS.ENDED);

    for (let pass = 0; pass < 3; pass += 1) {
      expect(await service.sweep()).toEqual({ markedStale: 0, ended: 0 });
    }

    const afterwards = await rowFor(session.id);
    // Not merely still ended: ended at the same instant. A sweep that rewrote
    // `ended_at` on every pass would be idempotent in status and lying about
    // when the session stopped.
    expect(afterwards.status).toBe(SESSION_STATUS.ENDED);
    expect(afterwards.endedAt?.getTime()).toBe(settled.endedAt?.getTime());
  });

  it('does not double-count or corrupt when two sweepers run at once', async () => {
    // The multi-instance case (Plan §8), reproduced in one process: two
    // services over the same pool, sweeping simultaneously. Correctness comes
    // from the compare-and-set in each statement's WHERE, not from any lock, so
    // this is the property that has to hold.
    await service.sweep();

    const batch = await Promise.all([register(), register(), register(), register()]);
    for (const session of batch) {
      await ageSession(session.id, HEARTBEAT_TIMEOUT_SECONDS + 1);
    }

    const other = createSessionService({ db, authorization: createAuthorizationService(db) });
    const [mine, theirs] = await Promise.all([service.sweep(), other.sweep()]);

    // Every row moved exactly once. Under READ COMMITTED the second UPDATE
    // re-evaluates `status = 'active'` against the committed row and skips what
    // the first one already took, so the counts partition the batch rather than
    // overlapping it.
    expect(mine.markedStale + theirs.markedStale).toBe(batch.length);

    for (const session of batch) {
      expect((await rowFor(session.id)).status).toBe(SESSION_STATUS.STALE);
    }
  });
});

describe('heartbeat', () => {
  it('keeps an active session active and moves its last-seen forward', async () => {
    const session = await register();
    await ageSession(session.id, 30);

    const before = await rowFor(session.id);
    const beaten = await service.heartbeat({ userId: alice, sessionId: session.id });

    expect(beaten.status).toBe(SESSION_STATUS.ACTIVE);
    expect(beaten.lastSeenAt.getTime()).toBeGreaterThan(before.lastSeenAt.getTime());
  });

  it('revives a stale session, because silence was an inference and this contradicts it', async () => {
    const session = await register();
    await ageSession(session.id, HEARTBEAT_TIMEOUT_SECONDS + 1);
    await service.sweep();
    expect((await rowFor(session.id)).status).toBe(SESSION_STATUS.STALE);

    const revived = await service.heartbeat({ userId: alice, sessionId: session.id });

    expect(revived.status).toBe(SESSION_STATUS.ACTIVE);
    // And presence comes back with it.
    expect(await presenceOf(aliceAgent, alpha)).toBeGreaterThan(0);
  });

  it('refuses an ended session with CONFLICT and a remedy, rather than reviving it', async () => {
    const session = await register();
    await service.end({ userId: alice, sessionId: session.id });

    const response = await responseFor(() =>
      service.heartbeat({ userId: alice, sessionId: session.id }),
    );

    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe(ErrorCode.CONFLICT);
    expect(response.body.error.message).toContain('agentchat listen');

    // Still ended. `ended` is terminal.
    expect((await rowFor(session.id)).status).toBe(SESSION_STATUS.ENDED);
  });

  it('refreshes the machine, which is what that column means', async () => {
    const machineName = `beat-${unique()}`;
    const session = await register({ machineName });

    await db
      .update(machines)
      .set({ lastSeenAt: sql`now() - make_interval(secs => 600)` })
      .where(eq(machines.id, session.machineId));

    const before = await db
      .select({ lastSeenAt: machines.lastSeenAt })
      .from(machines)
      .where(eq(machines.id, session.machineId));

    await service.heartbeat({ userId: alice, sessionId: session.id });

    const after = await db
      .select({ lastSeenAt: machines.lastSeenAt })
      .from(machines)
      .where(eq(machines.id, session.machineId));

    expect(after[0]?.lastSeenAt.getTime()).toBeGreaterThan(
      before[0]?.lastSeenAt.getTime() ?? Number.POSITIVE_INFINITY,
    );
  });
});

describe('teardown', () => {
  it('ends without removing the row, because deliveries point at it', async () => {
    const session = await register();

    const ended = await service.end({ userId: alice, sessionId: session.id });

    expect(ended.status).toBe(SESSION_STATUS.ENDED);
    // The row survives. `message_inbox.acked_by_session_id` and `deliveries`
    // resolve against it long after the listener is gone.
    expect((await rowFor(session.id)).id).toBe(session.id);
  });

  it('is idempotent, and keeps the first end instant on a retry', async () => {
    const session = await register();

    const first = await service.end({ userId: alice, sessionId: session.id });
    const second = await service.end({ userId: alice, sessionId: session.id });

    expect(second.status).toBe(SESSION_STATUS.ENDED);
    expect(second.endedAt?.getTime()).toBe(first.endedAt?.getTime());
  });

  it('does not rewrite the end instant when a teardown follows the sweeper', async () => {
    const session = await register();
    await ageSession(session.id, SESSION_END_AFTER_SECONDS + 1);
    await service.sweep();
    await service.sweep();

    const swept = await rowFor(session.id);
    expect(swept.status).toBe(SESSION_STATUS.ENDED);

    // The CLI's `SIGTERM` handler arrives late, after the sweeper already gave
    // up on the process. It must not move the moment the session ended.
    const ended = await service.end({ userId: alice, sessionId: session.id });
    expect(ended.endedAt?.getTime()).toBe(swept.endedAt?.getTime());
  });
});

/**
 * The path a closed socket takes (T-041).
 *
 * `websocket/heartbeat.ts` declared this as a port and named the contract it
 * needed; these are that contract, stated as SQL against a real database
 * because every clause of it is a claim about a statement — which statuses the
 * `UPDATE` matches, that it refreshes `last_seen_at`, that it cannot cross the
 * `sessions_ended_at_matches_status` check, and that it is scoped by the same
 * rule every other mutation here is scoped by.
 */
describe('marking a session stale, because its socket closed', () => {
  it('moves an active session to stale so presence stops claiming it is online', async () => {
    // Counted rather than compared with zero: every other test in this file
    // registers listeners for the same agent, and the claim here is about this
    // one leaving the count, not about the count being empty.
    const before = await presenceOf(aliceAgent, alpha);
    const session = await register();
    expect(await presenceOf(aliceAgent, alpha)).toBe(before + 1);

    const marked = await service.markStale({ userId: alice, sessionId: session.id });

    expect(marked.status).toBe(SESSION_STATUS.STALE);
    expect((await rowFor(session.id)).status).toBe(SESSION_STATUS.STALE);

    // The point of the whole path: a listener whose socket died stops being
    // reported as reachable, without waiting for the sweeper's minute.
    expect(await presenceOf(aliceAgent, alpha)).toBe(before);
  });

  it('does not wait for the sweeper, which is the latency this exists to remove', async () => {
    const session = await register();

    // Silent for well under the threshold: a sweep changes nothing here, and
    // that is exactly why the close hook has to do the work itself.
    await service.sweep();
    expect((await rowFor(session.id)).status).toBe(SESSION_STATUS.ACTIVE);

    await service.markStale({ userId: alice, sessionId: session.id });
    expect((await rowFor(session.id)).status).toBe(SESSION_STATUS.STALE);
  });

  it('refreshes last-seen on an already stale session rather than ageing it', async () => {
    const session = await register();
    await ageSession(session.id, HEARTBEAT_TIMEOUT_SECONDS + 1);
    await service.sweep();

    const stale = await rowFor(session.id);
    expect(stale.status).toBe(SESSION_STATUS.STALE);

    const marked = await service.markStale({ userId: alice, sessionId: session.id });

    // Still stale, and the timestamp moved forward. A reconnect-then-drop cycle
    // must not age a session faster than the disconnections themselves: if this
    // left `last_seen_at` alone, a listener that flapped for a day would be
    // ended by the second half of the sweep while it was still trying.
    expect(marked.status).toBe(SESSION_STATUS.STALE);
    expect(marked.lastSeenAt.getTime()).toBeGreaterThan(stale.lastSeenAt.getTime());
  });

  it('leaves an ended session alone without throwing, because that is the clean exit', async () => {
    const session = await register();
    const ended = await service.end({ userId: alice, sessionId: session.id });

    // `agentchat listen` sends `DELETE /sessions/:id` and *then* lets its
    // socket close. Answering CONFLICT here — which `heartbeat()` does, for a
    // client bug — would make every clean shutdown log a failure.
    const marked = await service.markStale({ userId: alice, sessionId: session.id });

    expect(marked.status).toBe(SESSION_STATUS.ENDED);
    expect(marked.endedAt?.getTime()).toBe(ended.endedAt?.getTime());

    const row = await rowFor(session.id);
    expect(row.status).toBe(SESSION_STATUS.ENDED);
    expect(row.endedAt).not.toBeNull();
  });

  it('refuses somebody else’s session, and says the same thing about one that never existed', async () => {
    const session = await register();

    const stranger = await responseFor(() =>
      service.markStale({ userId: bob, sessionId: session.id }),
    );
    const imaginary = await responseFor(() =>
      service.markStale({ userId: bob, sessionId: SessionId.generate() }),
    );

    expect(stranger.statusCode).toBe(404);
    expect(stranger.body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(stranger).toStrictEqual(imaginary);

    // And Bob's refusal changed nothing about Alice's listener.
    expect((await rowFor(session.id)).status).toBe(SESSION_STATUS.ACTIVE);
  });
});

describe('listing', () => {
  it('returns the caller’s own sessions and nobody else’s', async () => {
    const hers = await register();
    const his = await service.register({
      userId: bob,
      agentId: bobAgent,
      projectId: alpha,
      machineName: `bob-${unique()}`,
      runtime: 'codex',
      workingDirectory: '/home/bob/src',
    });

    const forAlice = await service.list({ userId: alice });
    const forBob = await service.list({ userId: bob });

    expect(forAlice.map((s) => s.id)).toContain(hers.id);
    expect(forAlice.map((s) => s.id)).not.toContain(his.id);
    expect(forBob.map((s) => s.id)).toContain(his.id);
    expect(forBob.map((s) => s.id)).not.toContain(hers.id);
  });

  it('narrows rather than widens when given a stranger’s agent', async () => {
    // Bob filtering on Alice's agent gets an empty list, not a refusal. A
    // refusal would confirm the id exists; the scoping is a join, so there is
    // nothing for the filter to widen to.
    const listed = await service.list({ userId: bob, agentId: aliceAgent });
    expect(listed).toEqual([]);
  });

  it('leaves ended sessions out unless asked', async () => {
    const session = await register();
    await service.end({ userId: alice, sessionId: session.id });

    const live = await service.list({ userId: alice });
    expect(live.map((s) => s.id)).not.toContain(session.id);

    const all = await service.list({ userId: alice, includeEnded: true });
    expect(all.map((s) => s.id)).toContain(session.id);
  });

  it('carries the hostname so a status listing needs no second round trip', async () => {
    const machineName = `named-${unique()}`;
    const session = await register({ machineName });

    const listed = await service.list({ userId: alice, agentId: aliceAgent });
    const found = listed.find((s) => s.id === session.id);

    expect(found?.machineName).toBe(machineName);
  });
});
