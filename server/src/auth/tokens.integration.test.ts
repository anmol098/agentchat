/**
 * The token service against a real PostgreSQL.
 *
 * `./tokens.test.ts` proves the service's logic over an in-memory store. That
 * store is only as honest as its author, and the two things the service leans
 * on hardest are precisely the two a hand-written fake gets to grant itself for
 * free:
 *
 * - **`claimForRotation` is a compare-and-swap.** In JavaScript, "check then
 *   write" is atomic by accident, because nothing interleaves between two
 *   statements in one function. In PostgreSQL it is atomic only if it is one
 *   statement whose predicate includes `revoked_at IS NULL`, and only the
 *   database can demonstrate that under genuine concurrency.
 * - **`transaction` rolls back.** The fake restores a snapshot because it was
 *   written to. `BEGIN`/`ROLLBACK` has to be shown doing the same to rows that
 *   have already been written by a statement that succeeded.
 *
 * Everything here therefore exercises `createDrizzleRefreshTokenStore` and the
 * SQL under it. The scenarios themselves — expiry, rotation, revocation,
 * reuse — are the same ones the unit suite covers, run again through the real
 * thing.
 *
 * The suite owns a freshly created database, migrated from the committed SQL,
 * and drops it afterwards. Integration tests share one server
 * (`vitest.config.ts`), so writing into the shared database would make this
 * suite's row counts depend on what else had run.
 *
 * @module
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { UserId } from '@agentchat/protocol';
import { eq } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { refreshTokens, users } from '../db/schema/identity.js';
import {
  CLOCK_SKEW_TOLERANCE_SECONDS,
  createDrizzleRefreshTokenStore,
  createTokenService,
  generateRefreshToken,
  hashRefreshToken,
  type RefreshTokenStore,
  REFRESH_TOKEN_TTL_SECONDS,
  RefreshTokenReuseError,
  type TokenService,
} from './tokens.js';

/** The generated SQL migrations, exactly as the server image will ship them. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const schema = { users, refreshTokens };

/** A secret long enough for the service to accept. Not a real one. */
const SECRET = 'z'.repeat(64);

/** One second, in milliseconds. */
const SECOND_MS = 1_000;

/** A short unique suffix so nothing collides between runs. */
const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 12);

let pool: Pool | undefined;
let db: NodePgDatabase<typeof schema>;
let store: RefreshTokenStore;
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

/**
 * Creates a user to hang refresh tokens off.
 *
 * `refresh_tokens.user_id` is a foreign key, so there is no way to test this
 * table without one.
 *
 * @returns The new user's identifier.
 */
async function createUser(): Promise<UserId> {
  const id = UserId.generate();
  const login = `u${unique()}`;

  await db.insert(users).values({
    id,
    githubId: unique(),
    username: login,
    displayName: login,
  });

  return id;
}

/**
 * Every refresh-token row for one user, oldest first.
 *
 * @param userId - Whose rows to read.
 * @returns The rows as stored.
 */
async function rowsFor(userId: UserId): Promise<(typeof refreshTokens.$inferSelect)[]> {
  return await db.select().from(refreshTokens).where(eq(refreshTokens.userId, userId));
}

/**
 * A service over the scratch database with a clock the test controls.
 *
 * @param now - Reads the instant the service should use.
 * @returns The service.
 */
function serviceWithClock(now: () => Date): TokenService {
  return createTokenService({ store, jwtSecret: SECRET, now });
}

beforeAll(async () => {
  databaseName = `agentchat_t104_${unique()}`;

  const admin = new Pool({ connectionString: process.env['DATABASE_URL'] });
  try {
    await admin.query(`create database "${databaseName}"`);
  } finally {
    await admin.end();
  }

  // More than one connection, deliberately: the concurrency test below needs
  // two transactions genuinely in flight at once, and a pool of one would
  // serialise them in the client and prove nothing about the database.
  pool = new Pool({ connectionString: urlForScratchDatabase(databaseName), max: 5 });
  db = drizzle(pool, { schema });

  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  store = createDrizzleRefreshTokenStore(db);
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

describe('storage', () => {
  it('writes a digest the schema accepts and never the token itself', async () => {
    // `refresh_tokens_token_hash_is_sha256` would reject a plaintext token
    // outright, so this passing is the database agreeing that what was stored
    // is a SHA-256 and not a credential.
    const userId = await createUser();
    const service = serviceWithClock(() => new Date());

    const issued = await service.issue({ userId });
    const [row] = await rowsFor(userId);

    expect(row?.tokenHash).toBe(hashRefreshToken(issued.refreshToken));
    expect(row?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.revokedAt).toBeNull();
  });

  it('gives the row the ninety-day expiry Plan §7 specifies', async () => {
    const userId = await createUser();
    const at = new Date('2026-03-01T12:00:00.000Z');

    await serviceWithClock(() => at).issue({ userId });
    const [row] = await rowsFor(userId);

    expect(row?.expiresAt.getTime()).toBe(at.getTime() + REFRESH_TOKEN_TTL_SECONDS * SECOND_MS);
  });
});

describe('rotation over SQL', () => {
  it('revokes the old row and inserts the new one', async () => {
    const userId = await createUser();
    const service = serviceWithClock(() => new Date());

    const first = await service.issue({ userId });
    const second = await service.refresh(first.refreshToken);

    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.tokenHash === hashRefreshToken(first.refreshToken))?.revokedAt)
      .not.toBeNull();
    expect(
      rows.find((row) => row.tokenHash === hashRefreshToken(second.refreshToken))?.revokedAt,
    ).toBeNull();
  });

  it('rolls the revoke back when the issue fails, in one real transaction', async () => {
    // A `ROLLBACK` after a statement that already succeeded. Without it the
    // user holds a token the server has revoked and no replacement — logged
    // out, with a credential that still looks fine to them.
    const userId = await createUser();
    const service = serviceWithClock(() => new Date());
    const issued = await service.issue({ userId });
    const tokenHash = hashRefreshToken(issued.refreshToken);

    await expect(
      store.transaction(async (tx) => {
        const claimed = await tx.claimForRotation(tokenHash, new Date());
        expect(claimed).toBeDefined();

        // Mid-transaction, the row really is revoked; this is the state the
        // rollback has to undo.
        expect((await tx.findByHash(tokenHash))?.revokedAt).not.toBeNull();

        throw new Error('the process died between the revoke and the issue');
      }),
    ).rejects.toThrow('died between the revoke and the issue');

    expect((await store.findByHash(tokenHash))?.revokedAt).toBeNull();
    // And the client's retry still works.
    await expect(service.refresh(issued.refreshToken)).resolves.toBeDefined();
  });

  it('lets exactly one of two concurrent rotations spend the token', async () => {
    // The race the compare-and-swap exists for. Both transactions are in flight
    // at once on different connections; the loser blocks on the row lock, then
    // re-evaluates `revoked_at IS NULL` against the winner's committed value
    // and matches nothing.
    const userId = await createUser();
    const service = serviceWithClock(() => new Date());
    const issued = await service.issue({ userId });

    const outcomes = await Promise.allSettled([
      service.refresh(issued.refreshToken),
      service.refresh(issued.refreshToken),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const loser = outcomes.find((outcome) => outcome.status === 'rejected');
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(RefreshTokenReuseError);
  });

  it('refuses a row whose expiry has passed', async () => {
    const userId = await createUser();
    const issuedAt = new Date('2026-01-01T00:00:00.000Z');
    const expired = new Date(
      issuedAt.getTime() + (REFRESH_TOKEN_TTL_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS) * SECOND_MS,
    );

    const issued = await serviceWithClock(() => issuedAt).issue({ userId });
    const failure = serviceWithClock(() => expired).refresh(issued.refreshToken);

    await expect(failure).rejects.toBeInstanceOf(Error);
    await expect(failure).rejects.not.toBeInstanceOf(RefreshTokenReuseError);
    // Never claimed, so nothing about the row should say it was spent.
    expect((await store.findByHash(hashRefreshToken(issued.refreshToken)))?.revokedAt).toBeNull();
  });
});

describe('reuse detection over SQL', () => {
  it('revokes every live row for the account, including the newest', async () => {
    const userId = await createUser();
    const service = serviceWithClock(() => new Date());

    const first = await service.issue({ userId });
    const second = await service.refresh(first.refreshToken);
    const third = await service.refresh(second.refreshToken);

    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );

    const rows = await rowsFor(userId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.revokedAt !== null)).toBe(true);
    await expect(service.refresh(third.refreshToken)).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );
  });

  it('leaves another account's rows alone', async () => {
    const victim = await createUser();
    const bystander = await createUser();
    const service = serviceWithClock(() => new Date());

    const compromised = await service.issue({ userId: victim });
    const untouched = await service.issue({ userId: bystander });
    await service.refresh(compromised.refreshToken);

    await expect(service.refresh(compromised.refreshToken)).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );

    expect((await store.findByHash(hashRefreshToken(untouched.refreshToken)))?.revokedAt).toBeNull();
  });

  it('does not fire for a token that was never issued here', async () => {
    const userId = await createUser();
    const service = serviceWithClock(() => new Date());
    const live = await service.issue({ userId });

    await expect(service.refresh(generateRefreshToken())).rejects.not.toBeInstanceOf(
      RefreshTokenReuseError,
    );

    expect((await store.findByHash(hashRefreshToken(live.refreshToken)))?.revokedAt).toBeNull();
  });
});

describe('logout over SQL', () => {
  it('revokes the presented row and only that row', async () => {
    const userId = await createUser();
    const service = serviceWithClock(() => new Date());
    const laptop = await service.issue({ userId });
    const desktop = await service.issue({ userId });

    await expect(service.logout(laptop.refreshToken)).resolves.toBe(true);

    expect((await store.findByHash(hashRefreshToken(laptop.refreshToken)))?.revokedAt).not.toBeNull();
    expect((await store.findByHash(hashRefreshToken(desktop.refreshToken)))?.revokedAt).toBeNull();
  });

  it('succeeds again on a token it has already revoked', async () => {
    const userId = await createUser();
    const service = serviceWithClock(() => new Date());
    const issued = await service.issue({ userId });

    await service.logout(issued.refreshToken);

    await expect(service.logout(issued.refreshToken)).resolves.toBe(false);
    await expect(service.logout(generateRefreshToken())).resolves.toBe(false);
  });
});
