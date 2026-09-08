import { describe, expect, it } from 'vitest';

/**
 * Sample test for the `integration` project.
 *
 * Two things are proven here. First, that `*.integration.test.ts` files are
 * collected by `pnpm test:integration` and skipped by `pnpm test`. Second,
 * that the DATABASE_URL gate in tests/setup/require-database-url.ts really did
 * run: if this test is executing at all, global setup let it through, so a
 * usable PostgreSQL URL is present.
 *
 * It deliberately opens no connection. No database driver is a dependency yet;
 * the task that adds one (the schema work in M1) should replace this file with
 * a test that actually queries. Until then this is the smoke test for the
 * wiring, not for Postgres.
 */
describe('integration test harness', () => {
  it('only runs once a PostgreSQL DATABASE_URL is configured', () => {
    const databaseUrl = process.env['DATABASE_URL'];
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is unset, so global setup did not gate this run.');
    }

    expect(new URL(databaseUrl).protocol).toMatch(/^postgres(ql)?:$/);
  });
});
