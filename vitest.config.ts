import { defineConfig } from 'vitest/config';

/**
 * Test runner configuration for the whole workspace.
 *
 * Vitest 5 removed `defineWorkspace` and the separate `vitest.workspace.ts`
 * file; multi-project setups are declared with `test.projects` in a single
 * config. There is exactly one Vitest installation, at the root, so every
 * package is covered from here rather than from a config per package.
 *
 * Two projects:
 *
 * - `unit` — the default. Pure, fast, no external services. `pnpm test` runs
 *   only this one, which is what the pre-pull-request gate in
 *   docs/SUBAGENT-PROTOCOL.md section 7.1 expects.
 * - `integration` — talks to a real PostgreSQL database, never a mock, because
 *   the schema constraints are the thing under test (Plan section 9). Run with
 *   `pnpm test:integration`.
 *
 * Membership of the `integration` project is decided by filename:
 * `*.integration.test.ts`. A filename is visible in a directory listing, in a
 * stack trace and in a CI log, which a runtime tag is not.
 */

/** Files that belong to the integration project, wherever they live. */
const integrationTests = '**/*.integration.test.ts';

/** Directories no project should ever descend into. */
const alwaysIgnored = [
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.git/**',
];

/**
 * Where tests are allowed to live.
 *
 * `tests/` at the root holds cross-cutting suites that belong to no single
 * package (today: the samples proving this wiring works). Package-local tests
 * sit next to the code they cover under `packages/<name>/src` and
 * `server/src`, which do not exist yet and are matched pre-emptively so no
 * later task has to touch this file just to be discovered.
 */
const unitTestGlobs = [
  'tests/unit/**/*.test.ts',
  'packages/*/src/**/*.test.ts',
  'packages/*/tests/**/*.test.ts',
  'server/src/**/*.test.ts',
  'server/tests/**/*.test.ts',
];

const integrationTestGlobs = [
  'tests/integration/**/*.integration.test.ts',
  'packages/*/src/**/*.integration.test.ts',
  'packages/*/tests/**/*.integration.test.ts',
  'server/src/**/*.integration.test.ts',
  'server/tests/**/*.integration.test.ts',
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: unitTestGlobs,
          exclude: [...alwaysIgnored, integrationTests],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: integrationTestGlobs,
          exclude: alwaysIgnored,

          // Refuses to start, with an actionable message, when DATABASE_URL is
          // missing or not a PostgreSQL URL. Without this the first test dies
          // inside a driver with something like ECONNREFUSED 127.0.0.1:5432,
          // which tells the reader nothing about what to do next.
          globalSetup: ['./tests/setup/require-database-url.ts'],

          // One database, one writer. Integration tests share schema and rows,
          // so running whole files concurrently would make failures depend on
          // scheduling.
          fileParallelism: false,

          // A cold container plus migrations is slower than a unit test.
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],

    // Coverage is a root-level concern: projects report into one directory so
    // a single lcov file describes the whole workspace. `coverage/` is
    // gitignored and removed by `pnpm clean`.
    coverage: {
      enabled: true,
      provider: 'v8',
      reportsDirectory: './coverage',
      reporter: ['text', 'html', 'lcov'],
      // Every source file is reported, not only the ones a test happened to
      // import, so an untested module shows up as 0% rather than vanishing.
      // (Vitest 5 removed the `all` flag; `include` is what decides this now.)
      include: ['packages/*/src/**/*.ts', 'server/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.test.ts', '**/*.integration.test.ts'],
      // No thresholds yet. There is no product code to measure; a threshold
      // added now would only be a number someone lowers later.
    },
  },
});
