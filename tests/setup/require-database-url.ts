/**
 * Global setup for the `integration` project.
 *
 * Integration tests run against a real PostgreSQL database, never a mock,
 * because the schema constraints are the thing under test
 * (docs/implementation-plan.md section 9). This gate turns "no database
 * configured" into one sentence a reader can act on, instead of whatever the
 * first driver call happens to throw several seconds later.
 */

const HELP = `
  Integration tests need a real PostgreSQL database. They never run against a
  mock, because the schema constraints are what they exist to test.

  Start a throwaway database and point DATABASE_URL at it:

    docker run --rm -d --name agentchat-test-db \\
      -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=agentchat_test \\
      -p 5433:5432 postgres:18

    export DATABASE_URL='postgres://postgres:postgres@localhost:5433/agentchat_test'

  Then run:

    pnpm test:integration

  Unit tests need none of this: 'pnpm test' runs them with no database at all.
`;

/** Thrown when DATABASE_URL is missing or unusable. Carries the fix, not just the fault. */
class MissingDatabaseUrlError extends Error {
  override readonly name = 'MissingDatabaseUrlError';

  constructor(problem: string) {
    super(`${problem}\n${HELP}`);
  }
}

/**
 * Verifies a usable PostgreSQL connection string is present before any
 * integration test file is loaded.
 *
 * @throws {MissingDatabaseUrlError} If `DATABASE_URL` is unset, empty, not a
 * valid URL, or not a `postgres:`/`postgresql:` URL.
 */
export function setup(): void {
  const raw = process.env['DATABASE_URL'];

  if (raw === undefined || raw.trim() === '') {
    throw new MissingDatabaseUrlError('DATABASE_URL is not set.');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    // The value itself is deliberately not echoed: connection strings carry
    // passwords, and this message can end up in a CI log.
    throw new MissingDatabaseUrlError('DATABASE_URL is set but is not a valid URL.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new MissingDatabaseUrlError(
      `DATABASE_URL must be a PostgreSQL URL, but its scheme is '${parsed.protocol.replace(':', '')}'.`,
    );
  }
}
