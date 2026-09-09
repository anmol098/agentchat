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
 * - `unit` — the default. No external services. Mostly fast and in-process,
 *   though some tests spawn the built binary on purpose; see
 *   `UNIT_TEST_TIMEOUT_MS`. `pnpm test` runs only this one, which is what the
 *   pre-pull-request gate in docs/SUBAGENT-PROTOCOL.md section 7.1 expects.
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

/**
 * How long a unit test may run before it is called hung.
 *
 * **Do not lower this because the suite is fast on your machine.** It is not
 * sized for your machine; it is sized for a machine that is also doing
 * something else. T-029 was filed after two tests failed at a load average of
 * 29, with six agents building and testing at once, and passed alone on the
 * same laptop seconds later.
 *
 * Vitest's 5 s default assumes a test calls a function and asserts on what it
 * returns. Most of this project's unit tests are that. Some are not, by
 * design:
 *
 * - `packages/cli/tests/*.test.ts` spawn the built binary, because the exit
 *   codes, the stdout/stderr split and the absence of colour on a pipe are
 *   only real in a separate process. One spawn costs ~150 ms on an idle
 *   machine, and `framework.test.ts` has a test that spawns seventeen of them
 *   in sequence to check every error code carries a hint.
 * - `server/src/routes/auth.test.ts` fills the pending-authorization store to
 *   its 10,000-record bound, because the bound is the thing under test.
 *
 * The measurements this number comes from, on an eight-core machine:
 *
 * | test                        | idle    | load ~29 | load ~140 |
 * | --------------------------- | ------- | -------- | --------- |
 * | seventeen spawns, one test  | 3.4 s   | 5.4 s    | > 5 s     |
 * | filling the store to 10,000 | 0.4 s   | 2.6 s    | 9.4 s     |
 * | every other unit test       | < 0.3 s | < 2.5 s  | < 3 s     |
 *
 * 20 s is about six times the worst honest cost on an idle machine and about
 * twice the worst measured under a badly oversubscribed one, so a laptop that
 * is also compiling has room. It is also short enough that a test which is
 * genuinely hung — an unresolved promise, a child that never exits — still
 * fails within a third of a minute instead of stalling the run. A minute would
 * buy nothing and cost every future debugging session.
 *
 * This is a backstop, not an assertion: no test passes or fails on its value.
 * A test that knows it is slower says so itself, which the build hooks in
 * `packages/cli/tests` already do with an explicit 180 s.
 *
 * The better fix for the two tests above is in the tests, not here. The
 * seventeen-spawn test repeats spawns the two `it.each` blocks above it have
 * already made, and could assert the hint from those instead; the store test is
 * quadratic because `sweep()` walks the whole map on every `start()`. Both
 * live in files T-029 did not own. If either is fixed, this number can come
 * down — but measure again under load before lowering it.
 */
const UNIT_TEST_TIMEOUT_MS = 20_000;

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
  // The end-to-end suite (T-314): a real server process, a real database and
  // real `agentchat` processes exchanging a message. It is in the `integration`
  // project rather than a third one so that the `integration` job in
  // .github/workflows/ci.yml — which already provides PostgreSQL, already
  // builds first, and is already required through the `ci` gate — fails the
  // build when end-to-end delivery regresses. A separate project would need a
  // separate job, a separate required check, and a branch-protection edit.
  'tests/e2e/**/*.integration.test.ts',
  // The chaos suite (T-509): the same real server, real database and real
  // `agentchat` processes as the end-to-end suite, with every connection
  // running through a relay the tests can sever, stall or point somewhere else.
  // It is in the `integration` project for the reason the line above gives —
  // the `integration` job already has PostgreSQL, already builds first, and is
  // already required — and because at-least-once delivery is worth claiming
  // only if the build fails when it stops being true.
  'tests/chaos/**/*.integration.test.ts',
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

          // Sized for a busy machine, not an idle one. See the constant.
          testTimeout: UNIT_TEST_TIMEOUT_MS,

          // Hooks keep Vitest's default. The only slow ones here are the
          // `buildPackage()` calls in `packages/cli/tests`, which already
          // carry an explicit 180 s of their own.
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
