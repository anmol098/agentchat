/**
 * Properties of the migration runner that hold without a database.
 *
 * There is exactly one: the advisory lock key. It is a constant that can never
 * change — two server versions using different keys would not see each other
 * and the lock would silently stop being a lock — so the literal is pinned to
 * its derivation here rather than left as a magic number somebody could
 * "tidy up".
 *
 * Everything else about the runner is a property of a real Postgres session and
 * is tested in `migrate.integration.test.ts`.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MIGRATION_LOCK_KEY } from '../migrate.js';

describe('the migration advisory lock key', () => {
  it('is the first eight bytes of sha256("agentchat:migrations") as a signed 64-bit integer', () => {
    const digest = createHash('sha256').update('agentchat:migrations').digest();
    const derived = BigInt.asIntN(64, digest.readBigUInt64BE(0));

    expect(MIGRATION_LOCK_KEY).toBe(derived);
  });

  it('fits the bigint Postgres accepts for pg_advisory_lock', () => {
    expect(MIGRATION_LOCK_KEY).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(MIGRATION_LOCK_KEY).toBeLessThan(2n ** 63n);
  });
});
