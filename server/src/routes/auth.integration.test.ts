/**
 * The account upsert a successful login performs, against a real PostgreSQL.
 *
 * `routes/auth.test.ts` proves what the *route* does with a directory; it
 * cannot prove what the directory does, because it substitutes one. And the
 * upsert is exactly the part whose behaviour is decided by the database rather
 * than by this repository: which conflict target fires, whether the update path
 * really updates instead of inserting a second row, and which constraint name a
 * collision arrives under. A stub would only demonstrate that the test and the
 * code agree about a conflict target neither of them executes.
 *
 * So the case that matters most here is the one no unit test can reach: two
 * different provider subjects claiming one username. The provider has to have
 * renamed somebody for that to happen, it is not recoverable by the client, and
 * {@link createUserDirectory} reports it as `CONFLICT` rather than as a 500 —
 * a distinction drawn by reading `constraint` off a `pg` error, which only a
 * real `pg` error carries.
 *
 * The suite owns a freshly created database, for the reason
 * `db/schema/tests/identity.integration.test.ts` gives: integration tests share
 * one server, and rows written here must not disturb another suite's.
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ErrorCode, ProtocolError, UserSchema } from '@agentchat/protocol';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ProviderIdentity } from '../auth/identity.js';
import { users } from '../db/schema/identity.js';
import { createUserDirectory, type UserDirectory } from './auth.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const schema = { users };

/** A short unique suffix for names that must not collide between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let directory: UserDirectory;
let databaseName: string;

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

/** An identity as the provider adapter hands one over: username already lowercased. */
function identityFor(overrides: Partial<ProviderIdentity> = {}): ProviderIdentity {
  return {
    subject: `gh-${unique()}`,
    username: `alice-${unique()}`,
    displayName: 'Alice Smith',
    email: 'alice@example.com',
    ...overrides,
  };
}

/** The rows currently stored for a provider subject. */
async function rowsForSubject(subject: string): Promise<(typeof users.$inferSelect)[]> {
  return await db.select().from(users).where(eq(users.githubId, subject));
}

/**
 * Runs an upsert expected to fail and returns the `ProtocolError` it threw.
 *
 * @param run - The upsert.
 * @returns The thrown error.
 * @throws {Error} If the upsert succeeded, so a genuine regression surfaces as
 * itself rather than as a missing assertion.
 */
async function rejection(run: () => Promise<unknown>): Promise<ProtocolError> {
  try {
    await run();
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProtocolError);
    return error as ProtocolError;
  }
  throw new Error('Expected the upsert to be rejected, but it succeeded.');
}

beforeAll(async () => {
  databaseName = `agentchat_t103_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName) });
  db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });

  directory = createUserDirectory(db);
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

describe('createUserDirectory', () => {
  it('creates an account the first time a person logs in', async () => {
    const identity = identityFor();

    const user = await directory.upsertFromIdentity(identity);

    expect(user.username).toBe(identity.username);
    expect(user.displayName).toBe('Alice Smith');
    expect(user.email).toBe('alice@example.com');
    expect(user.id).toMatch(/^usr_/);

    // Whatever the function returns, the row is what the next login reads.
    const stored = await rowsForSubject(identity.subject);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.username).toBe(identity.username);
  });

  it('returns an account the contract can carry', async () => {
    const user = await directory.upsertFromIdentity(identityFor());

    // Parsed rather than eyeballed: a column that drifts from `UserSchema` is a
    // server bug, and this is the boundary where it would reach a client.
    expect(UserSchema.parse(user)).toEqual(user);
    expect(() => new Date(user.createdAt).toISOString()).not.toThrow();
  });

  it('lowercases the username on the way into the column', async () => {
    // The provider adapter lowercases already; this proves the directory does
    // not rely on that, because `users_username_format` rejects anything else
    // and a 500 at login is a poor way to discover a second caller forgot.
    const identity = identityFor({ username: `MixedCase-${unique()}`.toUpperCase() });

    const user = await directory.upsertFromIdentity(identity);

    expect(user.username).toBe(identity.username.toLowerCase());
    expect(user.username).not.toBe(identity.username);
  });

  it('updates the same account rather than creating a second one', async () => {
    const identity = identityFor();
    const first = await directory.upsertFromIdentity(identity);

    const renamed = {
      ...identity,
      username: `renamed-${unique()}`,
      displayName: 'Alice R. Smith',
      email: 'alice.smith@example.com',
    };
    const second = await directory.upsertFromIdentity(renamed);

    // Matched on the subject, so a rename follows the person rather than
    // stranding them with a new account.
    expect(second.id).toBe(first.id);
    expect(second.username).toBe(renamed.username);
    expect(second.displayName).toBe('Alice R. Smith');
    expect(second.email).toBe('alice.smith@example.com');
    expect(await rowsForSubject(identity.subject)).toHaveLength(1);
  });

  it('clears an email the provider has stopped exposing', async () => {
    const identity = identityFor();
    await directory.upsertFromIdentity(identity);

    const user = await directory.upsertFromIdentity({ ...identity, email: null });

    expect(user.email).toBeNull();
  });

  it('keeps the creation date of the account it updates', async () => {
    const identity = identityFor();
    const first = await directory.upsertFromIdentity(identity);

    const second = await directory.upsertFromIdentity({ ...identity, displayName: 'Later' });

    expect(second.createdAt).toBe(first.createdAt);
  });

  it('reports a username taken by a different account as a conflict', async () => {
    const username = `taken-${unique()}`;
    await directory.upsertFromIdentity(identityFor({ username }));

    // A different person at the provider, now holding a username this server
    // has already given to somebody else. Not the caller's fault, not
    // recoverable here, and not a 500.
    const error = await rejection(() => directory.upsertFromIdentity(identityFor({ username })));

    expect(error.code).toBe(ErrorCode.CONFLICT);
    expect(error.message).not.toContain('insert into');
  });

  it('reports a row the database refuses as the server fault it is', async () => {
    // `users_username_format` rejects this; nothing about it is the client's
    // doing, so it must not arrive as a 4xx.
    const error = await rejection(() =>
      directory.upsertFromIdentity(identityFor({ username: 'not a valid username' })),
    );

    expect(error.code).toBe(ErrorCode.INTERNAL);
  });
});
