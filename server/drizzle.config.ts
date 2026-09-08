import { defineConfig } from 'drizzle-kit';

/**
 * The connection string drizzle-kit uses when `DATABASE_URL` is not set.
 *
 * It matches the defaults in the repository's `docker-compose.yml`, so
 * `docker compose up -d postgres` followed by `pnpm --filter @agentchat/server
 * db:generate` works with no further setup. Nothing outside development should
 * ever fall back to this: the server itself requires `DATABASE_URL` and fails
 * to start without it.
 */
const DEV_DATABASE_URL = 'postgres://agentchat:agentchat@localhost:5432/agentchat';

export default defineConfig({
  dialect: 'postgresql',

  // Every TypeScript file in this directory is a model. T-101 and T-301 add
  // them; there are none yet, which drizzle-kit tolerates. The `*.ts` glob
  // matters: given a bare directory drizzle-kit tries to execute *every* entry
  // it finds, including a placeholder or a stray .md.
  schema: './src/db/schema/*.ts',

  // Migrations are plain, numbered SQL files committed to the repository and
  // copied into the server image, so an operator never needs a checkout to
  // upgrade (Plan §12.2). The `index` prefix is what produces 0000_*.sql,
  // 0001_*.sql and so on; a timestamp prefix would make the ordering harder to
  // read in review and harder to reason about when two branches both add one.
  out: './drizzle',
  migrations: {
    prefix: 'index',
  },

  // Loud by default. `strict` makes drizzle-kit ask before running destructive
  // statements and `verbose` prints the SQL it is about to execute, which is
  // the difference between noticing a bad generated migration in review and
  // noticing it in production.
  strict: true,
  verbose: true,

  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? DEV_DATABASE_URL,
  },
});
