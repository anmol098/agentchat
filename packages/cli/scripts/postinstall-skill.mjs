#!/usr/bin/env node
// This runs after `npm install`, including a global one. Its only job is to
// install this package's bundled Skill (`skills/agentchat` in the source
// repository) for whatever coding-agent harness is on this machine, via
// `npx skills add` (https://skills.sh). It is best-effort in every direction:
// nothing here may ever fail, hang, or slow down an install that has nothing
// to do with skills. See docs/cli.md's Install section for the user-facing
// description of this, and T-515 in docs/progress/tasks for why each guard
// below exists.

import { spawnSync } from 'node:child_process';

const SKILL_REPO = 'anmol098/agentchat';
const SKILL_NAME = 'agentchat';

// 30s in normal operation. Overridable so the test suite can bound a fake
// `npx` that hangs on purpose without an actual 30-second wait; not meant to
// be a user-facing tuning knob.
const TIMEOUT_MS = Number(process.env.AGENTCHAT_SKILL_INSTALL_TIMEOUT_MS) || 30_000;

function note(message) {
  process.stderr.write(`agentchat: ${message}\n`);
}

function main() {
  if (process.env.AGENTCHAT_SKIP_SKILL_INSTALL) {
    note('skipping the automatic Skill install (AGENTCHAT_SKIP_SKILL_INSTALL is set).');
    return;
  }

  if (process.env.CI) {
    note('skipping the automatic Skill install (running in CI).');
    return;
  }

  // Only an actual `-g`/`--global` install of the published package should
  // mint a skill onto this machine. npm and pnpm both put the config flag in
  // effect into the environment as `npm_config_global`, present and "true"
  // only for that flag, which is also what keeps this inert during this
  // monorepo's own `pnpm install` (`packages/cli` is a workspace member, and
  // that is never a global install) and when someone adds
  // `@anmol098/agentchat` as an ordinary project dependency instead of
  // installing it globally.
  if (process.env.npm_config_global !== 'true') {
    return;
  }

  note(
    `installing the ${SKILL_NAME} Skill for any coding-agent harness on this machine ` +
      `(npx skills add ${SKILL_REPO}). Set AGENTCHAT_SKIP_SKILL_INSTALL=1 to skip this next time.`,
  );

  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--yes', 'skills', 'add', SKILL_REPO, '--skill', SKILL_NAME, '-g', '-y'],
    {
      // No stdin: a prompt this can't answer should fail fast, not hang
      // waiting on one. A hard timeout is the backstop for everything else —
      // a stalled network call must never hang `npm install`.
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: TIMEOUT_MS,
    },
  );

  if (result.error || result.status !== 0) {
    note(
      `could not install the Skill automatically; run \`npx skills add ${SKILL_REPO}\` yourself if you want it.`,
    );
  }
}

try {
  main();
} catch (error) {
  note(`skipping the automatic Skill install (unexpected error: ${error?.message ?? error}).`);
}

// This step must never fail the parent install, whatever happened above.
process.exitCode = 0;
