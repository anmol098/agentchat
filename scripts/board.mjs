#!/usr/bin/env node
/**
 * AgentChat progress board.
 *
 * The board is derived state. The source of truth is one Markdown file per task
 * in docs/progress/tasks/, each owned by exactly one agent at a time. That
 * single-writer rule is what keeps parallel worktrees from conflicting on the
 * board; see docs/SUBAGENT-PROTOCOL.md.
 *
 * Usage: node scripts/board.mjs <command> [args]
 * Run with no arguments for help.
 */

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASK_DIR = join(ROOT, 'docs/progress/tasks');
const BOARD_FILE = join(ROOT, 'docs/progress/BOARD.md');

const STATUSES = ['todo', 'in_progress', 'in_review', 'blocked', 'done'];
const STATUS_LABEL = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  blocked: 'Blocked',
  done: 'Done',
};

// ---------------------------------------------------------------------------
// Frontmatter parsing
// ---------------------------------------------------------------------------

/** Parse the subset of YAML used in task frontmatter. */
function parseFrontmatter(text, file) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${file}: missing or malformed frontmatter block`);

  const data = {};
  const lines = match[1].split('\n');
  let currentListKey = null;

  for (const raw of lines) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;

    const listItem = /^\s+-\s+(.*)$/.exec(raw);
    if (listItem) {
      if (!currentListKey) throw new Error(`${file}: list item outside of a key: ${raw}`);
      data[currentListKey].push(unquote(listItem[1].trim()));
      continue;
    }

    const pair = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(raw);
    if (!pair) throw new Error(`${file}: cannot parse frontmatter line: ${raw}`);

    const [, key, rawValue] = pair;
    const value = rawValue.trim();
    currentListKey = null;

    if (value === '') {
      data[key] = [];
      currentListKey = key;
    } else if (value === 'null' || value === '~') {
      data[key] = null;
    } else if (value.startsWith('[')) {
      const inner = value.slice(1, value.lastIndexOf(']')).trim();
      data[key] = inner ? inner.split(',').map((v) => unquote(v.trim())) : [];
    } else {
      data[key] = unquote(value);
    }
  }

  return { data, body: match[2] };
}

function unquote(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function serializeFrontmatter(data) {
  const order = [
    'id',
    'title',
    'milestone',
    'status',
    'owner',
    'branch',
    'pr',
    'estimate',
    'depends_on',
    'paths',
    'blocked_reason',
  ];
  const keys = [
    ...order.filter((k) => k in data),
    ...Object.keys(data).filter((k) => !order.includes(k)),
  ];

  return keys
    .map((key) => {
      const value = data[key];
      if (value === null || value === undefined) return `${key}: null`;
      if (Array.isArray(value)) {
        if (value.length === 0) return `${key}: []`;
        if (key === 'paths') return `${key}:\n${value.map((v) => `  - ${v}`).join('\n')}`;
        return `${key}: [${value.join(', ')}]`;
      }
      return `${key}: ${needsQuotes(value) ? JSON.stringify(value) : value}`;
    })
    .join('\n');
}

function needsQuotes(value) {
  return (
    typeof value === 'string' &&
    (value.includes(': ') || value.startsWith('[') || value.startsWith('#'))
  );
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

function loadTasks() {
  const files = readdirSync(TASK_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();
  return files.map((file) => {
    const path = join(TASK_DIR, file);
    const { data, body } = parseFrontmatter(readFileSync(path, 'utf8'), file);
    return { ...data, body, file, path };
  });
}

function saveTask(task) {
  const { body, file, path, ...data } = task;
  writeFileSync(path, `---\n${serializeFrontmatter(data)}\n---\n${body}`);
}

function findTask(tasks, id) {
  const task = tasks.find((t) => t.id === id.toUpperCase());
  if (!task) fail(`No such task: ${id}`);
  return task;
}

// ---------------------------------------------------------------------------
// Path collision
// ---------------------------------------------------------------------------

/** True when two declared paths could touch the same file. */
function pathsCollide(a, b) {
  const na = a.replace(/\/+$/, '');
  const nb = b.replace(/\/+$/, '');
  return na === nb || na.startsWith(`${nb}/`) || nb.startsWith(`${na}/`);
}

function tasksCollide(a, b) {
  return a.paths.some((pa) => b.paths.some((pb) => pathsCollide(pa, pb)));
}

function collidingPaths(a, b) {
  const hits = [];
  for (const pa of a.paths) {
    for (const pb of b.paths) {
      if (pathsCollide(pa, pb)) hits.push(pa === pb ? pa : `${pa} ~ ${pb}`);
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Scope: what a branch actually changed, against what it said it would
// ---------------------------------------------------------------------------

/**
 * Files every task may change, whatever it declared.
 *
 * The first two are how a task reports on itself; refusing them would fail
 * every task on its own progress log. `docs/protocol.md` is here because §7.6
 * of the protocol *requires* a wire change to update it in the same pull
 * request — flagging every such change would train a reviewer to skim past this
 * check's output, which is the one thing that would make it worthless.
 *
 * @param task - The task whose branch is being examined.
 * @returns Paths allowed in addition to the task's declared ones.
 */
function alwaysAllowed(task) {
  return [
    `docs/progress/tasks/${task.id}.md`,
    'docs/progress/BOARD.md',
    'docs/protocol.md',
    // Generated by `pnpm protocol:check`, which instructs committing it beside
    // the change that moved it. Any task that touches the wire contract
    // regenerates it, so declaring ownership of it would make every such task
    // collide with every other for a file none of them writes by hand. On a
    // conflict the answer is always to regenerate, never to merge.
    'scripts/protocol-snapshot.json',
  ];
}

/**
 * True when a changed file falls inside a declared path.
 *
 * A declared directory covers everything beneath it, by the same rule the
 * collision check uses. A declared *file* additionally covers the tests written
 * for it. Without that, a task that writes the tests it was asked to write
 * fails this check, and a check that fires on correct work is one people learn
 * to ignore.
 *
 * ## Where a test for `x.ts` is allowed to live
 *
 * Two layouts, because this repository uses both. Beside the source, as
 * `a/b/c.test.ts` and `a/b/c.integration.test.ts`; or under a `tests/`
 * directory in any ancestor package, as `server/tests/migrate.test.ts` for
 * `server/src/db/migrate.ts`.
 *
 * The first rule alone was the whole rule, and it never fired, because the
 * server and the CLI both keep their tests in `tests/`. Every task touching a
 * test file had to widen its declared paths for it, one by one, which is the
 * friction that makes a check get switched off.
 *
 * The `tests/` half matches on the file's *basename stem*, not its directory,
 * so `server/src/db/migrate.ts` covers `server/tests/migrate.test.ts` but not
 * `server/tests/sessions.test.ts`. That is looser than the sibling rule and
 * deliberately so: a test directory is flat and the source tree is not, so a
 * stricter rule would have no signal to work from. It is still tight enough to
 * catch a task rewriting a test suite it has nothing to do with.
 *
 * A declared *directory* gets no such extension. `server/src` does not reach
 * `server/tests`, because two tasks declaring `server/src/routes` and
 * `server/src/websocket` would then both silently own the whole test tree, and
 * the collision check would see nothing. A task that owns a directory and
 * writes tests under `tests/` declares that path too.
 *
 * @param file - Repository-relative path of a changed file.
 * @param declared - One declared path from the task.
 * @returns Whether the file is covered.
 */
function fileIsInScope(file, declared) {
  const root = declared.replace(/\/+$/, '');
  if (file === root || file.startsWith(`${root}/`)) return true;

  const dot = root.lastIndexOf('.');
  if (dot <= root.lastIndexOf('/')) return false;

  const stem = root.slice(0, dot);
  const extension = root.slice(dot);

  // Beside the source: `a/b/c.ts` -> `a/b/c.test.ts`.
  if (file.startsWith(`${stem}.`) && file.endsWith(`.test${extension}`)) return true;

  // In a `tests/` directory of some ancestor: `server/src/db/migrate.ts` ->
  // `server/tests/migrate.test.ts`, or `.../tests/integration/migrate.test.ts`.
  const basename = stem.slice(stem.lastIndexOf('/') + 1);
  if (!file.endsWith(`.test${extension}`) && !file.endsWith(`.test.ts`)) return false;

  const segments = file.split('/');
  const testsAt = segments.indexOf('tests');
  if (testsAt === -1) return false;

  // The `tests/` directory has to sit inside the declared file's own package,
  // so a task in `server/` cannot reach `packages/cli/tests/`.
  const packageRoot = segments.slice(0, testsAt).join('/');
  if (packageRoot !== '' && !root.startsWith(`${packageRoot}/`)) return false;

  const testName = segments[segments.length - 1] ?? '';
  return testName.startsWith(`${basename}.`);
}

/**
 * Every path this branch has touched, committed or not.
 *
 * Uncommitted work counts. Catching an undeclared edit only once it is
 * committed would mean catching it after two agents have already been editing
 * the same file, which is the situation this exists to prevent.
 *
 * @param base - The ref the branch diverged from.
 * @returns Repository-relative paths, deduplicated and sorted.
 */
function changedFiles(base) {
  const git = (args) =>
    execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  let mergeBase;
  try {
    mergeBase = git(['merge-base', base, 'HEAD']).trim();
  } catch {
    fail(`cannot find a merge base with "${base}"; pass --base <ref> with one that exists`);
  }

  const committed = git(['diff', '--name-only', `${mergeBase}...HEAD`]);
  // `--porcelain` rather than `diff`, so untracked files are included: a new
  // file nobody has added yet is exactly the undeclared change worth catching.
  const working = git(['status', '--porcelain', '--untracked-files=all']);

  const files = new Set(committed.split('\n').filter(Boolean));
  for (const line of working.split('\n')) {
    if (line.trim() === '') continue;
    // "XY path" or, for a rename, "XY old -> new". The destination is ours.
    const path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    files.add(arrow === -1 ? path : path.slice(arrow + 4));
  }

  return [...files].sort();
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

function isReady(task, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.depends_on.every((dep) => byId.get(dep)?.status === 'done');
}

function unmetDeps(task, tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return task.depends_on.filter((dep) => byId.get(dep)?.status !== 'done');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(tasks) {
  const counts = Object.fromEntries(
    STATUSES.map((s) => [s, tasks.filter((t) => t.status === s).length]),
  );
  const done = counts.done;
  const total = tasks.length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const filled = Math.round(pct / 5);

  const milestones = [...new Set(tasks.map((t) => t.milestone))].sort();

  const lines = [];
  lines.push('# AgentChat Progress Board');
  lines.push('');
  lines.push('> Generated by `node scripts/board.mjs render`. **Do not edit by hand.**');
  lines.push('> The source of truth is one file per task in [`tasks/`](./tasks/).');
  lines.push(
    '> Claiming, updating, and quality rules: [Subagent Protocol](../SUBAGENT-PROTOCOL.md).',
  );
  lines.push('');
  lines.push('## Overall');
  lines.push('');
  lines.push('```text');
  lines.push(
    `[${'#'.repeat(filled)}${'.'.repeat(20 - filled)}] ${pct}%   ${done}/${total} tasks done`,
  );
  lines.push('```');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('|--------|-------|');
  for (const s of STATUSES) lines.push(`| ${STATUS_LABEL[s]} | ${counts[s]} |`);
  lines.push('');
  lines.push('## By milestone');
  lines.push('');
  lines.push('| Milestone | Done | Total | Progress |');
  lines.push('|-----------|------|-------|----------|');
  for (const m of milestones) {
    const inM = tasks.filter((t) => t.milestone === m);
    const d = inM.filter((t) => t.status === 'done').length;
    const p = Math.round((d / inM.length) * 100);
    lines.push(`| ${m} | ${d} | ${inM.length} | ${p}% |`);
  }
  lines.push('');

  for (const m of milestones) {
    const inM = tasks.filter((t) => t.milestone === m);
    lines.push(`## ${m}`);
    lines.push('');
    lines.push('| ID | Task | Status | Owner | Depends on |');
    lines.push('|----|------|--------|-------|------------|');
    for (const t of inM) {
      const deps = t.depends_on.length ? t.depends_on.join(', ') : '—';
      const owner = t.owner ?? '—';
      const link = `[${t.id}](./tasks/${t.id}.md)`;
      lines.push(`| ${link} | ${t.title} | ${STATUS_LABEL[t.status]} | ${owner} | ${deps} |`);
    }
    lines.push('');
  }

  const ready = tasks.filter((t) => t.status === 'todo' && isReady(t, tasks));
  lines.push('## Ready to claim');
  lines.push('');
  if (ready.length === 0) {
    lines.push('_Nothing is unblocked right now._');
  } else {
    for (const t of ready) lines.push(`- **${t.id}** — ${t.title}`);
  }
  lines.push('');

  const blocked = tasks.filter((t) => t.status === 'blocked');
  if (blocked.length) {
    lines.push('## Blocked');
    lines.push('');
    for (const t of blocked)
      lines.push(`- **${t.id}** — ${t.title}: ${t.blocked_reason ?? 'no reason recorded'}`);
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function check(tasks) {
  const errors = [];
  const ids = new Set();

  for (const t of tasks) {
    const where = t.file;
    if (!t.id) errors.push(`${where}: missing id`);
    if (t.id && ids.has(t.id)) errors.push(`${where}: duplicate id ${t.id}`);
    if (t.id) ids.add(t.id);
    if (t.id && t.file !== `${t.id}.md`)
      errors.push(`${where}: filename must match id (${t.id}.md)`);
    if (!t.title) errors.push(`${where}: missing title`);
    if (!t.milestone) errors.push(`${where}: missing milestone`);
    if (!STATUSES.includes(t.status)) errors.push(`${where}: invalid status "${t.status}"`);
    if (!Array.isArray(t.paths) || t.paths.length === 0)
      errors.push(`${where}: must declare at least one owned path`);
    if (!Array.isArray(t.depends_on)) errors.push(`${where}: depends_on must be a list`);
    if (t.status === 'in_progress' && !t.owner)
      errors.push(`${where}: in_progress requires an owner`);
    if (t.status === 'blocked' && !t.blocked_reason)
      errors.push(`${where}: blocked requires blocked_reason`);
    if (!/^##\s+Acceptance criteria/m.test(t.body))
      errors.push(`${where}: missing "## Acceptance criteria" section`);
    if (!/^##\s+Log/m.test(t.body)) errors.push(`${where}: missing "## Log" section`);
  }

  for (const t of tasks) {
    for (const dep of t.depends_on ?? []) {
      if (!ids.has(dep)) errors.push(`${t.file}: depends on unknown task ${dep}`);
    }
  }

  // Dependency cycles.
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map();
  const walk = (id, trail) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') {
      errors.push(`Dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'open');
    for (const dep of byId.get(id)?.depends_on ?? []) walk(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const t of tasks) walk(t.id, []);

  // Two agents must never be working on overlapping paths.
  const active = tasks.filter((t) => t.status === 'in_progress' || t.status === 'in_review');
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      if (tasksCollide(active[i], active[j])) {
        errors.push(
          `Path collision between active tasks ${active[i].id} and ${active[j].id}: ${collidingPaths(active[i], active[j]).join(', ')}`,
        );
      }
    }
  }

  // A done task must not depend on something unfinished.
  for (const t of tasks.filter((x) => x.status === 'done')) {
    for (const dep of unmetDeps(t, tasks)) {
      errors.push(`${t.id} is done but depends on unfinished ${dep}`);
    }
  }

  // The rendered board must match the task files.
  let current = '';
  try {
    current = readFileSync(BOARD_FILE, 'utf8');
  } catch {
    errors.push('docs/progress/BOARD.md is missing; run: node scripts/board.mjs render');
  }
  if (current && current.trimEnd() !== render(tasks).trimEnd()) {
    errors.push('docs/progress/BOARD.md is stale; run: node scripts/board.mjs render');
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function fail(message) {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

function has(argv, name) {
  return argv.includes(`--${name}`);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Append a dated entry to the task's Log section, oldest first.
 * Rebuilds the section so repeated edits cannot accumulate blank lines.
 */
function appendLog(task, message) {
  const entry = `- ${today()} — ${message}`;
  const heading = /^##\s+Log\s*$/m.exec(task.body);

  if (!heading) {
    task.body = `${task.body.trimEnd()}\n\n## Log\n\n${entry}\n`;
    return;
  }

  const head = task.body.slice(0, heading.index);
  const existing = task.body
    .slice(heading.index + heading[0].length)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '));

  task.body = `${head}## Log\n\n${[...existing, entry].join('\n')}\n`;
}

function renderAndSave(tasks) {
  writeFileSync(BOARD_FILE, `${render(tasks).trimEnd()}\n`);
}

const commands = {
  list(argv) {
    const tasks = loadTasks();
    const status = flag(argv, 'status');
    const milestone = flag(argv, 'milestone');
    const readyOnly = has(argv, 'ready');

    let out = tasks;
    if (status) out = out.filter((t) => t.status === status);
    if (milestone) out = out.filter((t) => t.milestone === milestone);
    if (readyOnly) out = out.filter((t) => isReady(t, tasks));

    if (out.length === 0) {
      process.stdout.write('No matching tasks.\n');
      return;
    }
    for (const t of out) {
      const owner = t.owner ? ` @${t.owner}` : '';
      process.stdout.write(
        `${t.id}  ${t.milestone}  ${t.status.padEnd(11)}${owner.padEnd(16)} ${t.title}\n`,
      );
    }
  },

  show(argv) {
    const tasks = loadTasks();
    const task = findTask(tasks, argv[0] ?? fail('usage: show <ID>'));
    const unmet = unmetDeps(task, tasks);
    process.stdout.write(`${task.id} — ${task.title}\n`);
    process.stdout.write(`milestone: ${task.milestone}\n`);
    process.stdout.write(
      `status:    ${task.status}${task.blocked_reason ? ` (${task.blocked_reason})` : ''}\n`,
    );
    process.stdout.write(`owner:     ${task.owner ?? '—'}\n`);
    process.stdout.write(`branch:    ${task.branch ?? '—'}\n`);
    process.stdout.write(
      `depends:   ${task.depends_on.join(', ') || '—'}${unmet.length ? `  (unmet: ${unmet.join(', ')})` : ''}\n`,
    );
    process.stdout.write(`paths:\n${task.paths.map((p) => `  ${p}`).join('\n')}\n`);
    process.stdout.write(`\n${task.body.trim()}\n`);
  },

  claim(argv) {
    const id = argv[0] ?? fail('usage: claim <ID> --owner <name>');
    const owner = flag(argv, 'owner') ?? fail('--owner is required');
    const tasks = loadTasks();
    const task = findTask(tasks, id);

    if (task.status !== 'todo') {
      fail(
        `${task.id} is ${task.status}${task.owner ? ` (owner: ${task.owner})` : ''}, not todo. Pick another task.`,
      );
    }
    const unmet = unmetDeps(task, tasks);
    if (unmet.length) fail(`${task.id} depends on unfinished tasks: ${unmet.join(', ')}`);

    for (const other of tasks) {
      if (other.id === task.id) continue;
      if (other.status !== 'in_progress' && other.status !== 'in_review') continue;
      if (tasksCollide(task, other)) {
        fail(
          `${task.id} owns paths that ${other.id} (${other.status}, ${other.owner}) is already working on: ${collidingPaths(task, other).join(', ')}`,
        );
      }
    }

    const slug = task.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .split('-')
      .slice(0, 5)
      .join('-');
    task.status = 'in_progress';
    task.owner = owner;
    task.branch = `task/${task.id}-${slug}`;
    appendLog(task, `Claimed by ${owner}.`);
    saveTask(task);
    renderAndSave(loadTasks());

    process.stdout.write(`Claimed ${task.id} for ${owner}.\n\n`);
    process.stdout.write('Next:\n');
    process.stdout.write(`  git add docs/progress/tasks/${task.id}.md docs/progress/BOARD.md\n`);
    process.stdout.write(`  git commit -m "chore(board): claim ${task.id}"\n`);
    process.stdout.write(
      '  git push origin main   # this push is the lock; if it is rejected, you lost the race\n',
    );
    process.stdout.write(
      `  git worktree add ../agentchat-${task.id} -b ${task.branch} origin/main\n`,
    );
  },

  status(argv) {
    const id = argv[0] ?? fail('usage: status <ID> <status> [--pr N] [--reason "…"]');
    const next = argv[1] ?? fail(`usage: status <ID> <${STATUSES.join('|')}>`);
    if (!STATUSES.includes(next))
      fail(`invalid status "${next}"; expected one of ${STATUSES.join(', ')}`);

    const tasks = loadTasks();
    const task = findTask(tasks, id);
    const reason = flag(argv, 'reason');
    const pr = flag(argv, 'pr');

    if (next === 'blocked' && !reason) fail('--reason is required when blocking a task');

    const previous = task.status;
    task.status = next;
    if (pr) task.pr = pr;
    if (next === 'blocked') task.blocked_reason = reason;
    else task.blocked_reason = null;
    if (next === 'todo') {
      task.owner = null;
      task.branch = null;
    }

    appendLog(
      task,
      `Status ${previous} -> ${next}${reason ? `: ${reason}` : ''}${pr ? ` (PR #${pr})` : ''}.`,
    );
    saveTask(task);
    renderAndSave(loadTasks());
    process.stdout.write(`${task.id}: ${previous} -> ${next}\n`);
  },

  log(argv) {
    const id = argv[0] ?? fail('usage: log <ID> "<message>"');
    const message = argv
      .slice(1)
      .filter((a) => !a.startsWith('--'))
      .join(' ');
    if (!message) fail('a log message is required');
    const task = findTask(loadTasks(), id);
    appendLog(task, message);
    saveTask(task);
    renderAndSave(loadTasks());
    process.stdout.write(`Logged against ${task.id}.\n`);
  },

  plan() {
    const tasks = loadTasks();
    const ready = tasks.filter((t) => t.status === 'todo' && isReady(t, tasks));
    const active = tasks.filter((t) => t.status === 'in_progress' || t.status === 'in_review');

    const batch = [];
    for (const candidate of ready) {
      const clashesWithActive = active.some((a) => tasksCollide(candidate, a));
      const clashesWithBatch = batch.some((b) => tasksCollide(candidate, b));
      if (!clashesWithActive && !clashesWithBatch) batch.push(candidate);
    }

    if (active.length) {
      process.stdout.write(`Currently active (${active.length}):\n`);
      for (const t of active)
        process.stdout.write(`  ${t.id}  ${t.status.padEnd(11)} ${t.owner ?? '—'}  ${t.title}\n`);
      process.stdout.write('\n');
    }
    if (batch.length === 0) {
      process.stdout.write('No task can start in parallel right now.\n');
      return;
    }
    process.stdout.write(`Safe to run in parallel now (${batch.length}, no path overlap):\n`);
    for (const t of batch) process.stdout.write(`  ${t.id}  ${t.milestone}  ${t.title}\n`);
  },

  scope(argv) {
    const id = argv[0] ?? fail('usage: scope <ID> [--base <ref>]');
    const task = findTask(loadTasks(), id);
    const base = flag(argv, 'base') ?? 'origin/main';

    const allowed = [...task.paths, ...alwaysAllowed(task)];
    const changed = changedFiles(base);
    const outside = changed.filter((file) => !allowed.some((p) => fileIsInScope(file, p)));

    process.stdout.write(`${task.id} changed ${changed.length} file(s) since ${base}.\n`);

    if (outside.length === 0) {
      process.stdout.write('All of them are inside its declared paths.\n');
      return;
    }

    process.stderr.write(`\n${outside.length} file(s) outside ${task.id}'s declared paths:\n`);
    for (const file of outside) process.stderr.write(`  ${file}\n`);
    process.stderr.write(`\n${task.id} declares:\n`);
    for (const p of task.paths) process.stderr.write(`  ${p}\n`);
    process.stderr.write(
      '\nTwo agents can edit the same file for an hour with every other board\n' +
        'command reporting success, because a path nobody declares collides with\n' +
        'nothing. So this is not a formality.\n\n' +
        "Either revert the files above, or widen this task's `paths` deliberately\n" +
        'and say in its Log why the original declaration was wrong. Check first,\n' +
        'with `node scripts/board.mjs check`, that widening it does not collide\n' +
        'with a task somebody else is already running.\n',
    );
    process.exit(1);
  },

  check() {
    const errors = check(loadTasks());
    if (errors.length === 0) {
      process.stdout.write('Board OK.\n');
      return;
    }
    for (const e of errors) process.stderr.write(`error: ${e}\n`);
    process.stderr.write(`\n${errors.length} problem(s) found.\n`);
    process.exit(1);
  },

  render() {
    renderAndSave(loadTasks());
    process.stdout.write('Wrote docs/progress/BOARD.md\n');
  },
};

const [, , command, ...argv] = process.argv;

if (!command || command === 'help' || command === '--help') {
  process.stdout.write(`AgentChat progress board

  list [--status S] [--milestone M] [--ready]   list tasks
  show <ID>                                     full detail for one task
  claim <ID> --owner <name>                     take a todo task
  status <ID> <status> [--pr N] [--reason "…"]  move a task along
  log <ID> "<message>"                          append a progress entry
  plan                                          largest safe parallel batch
  scope <ID> [--base <ref>]                     files this branch changed vs. its declared paths
  check                                         validate the board (CI gate)
  render                                        regenerate BOARD.md

Statuses: ${STATUSES.join(', ')}
Protocol: docs/SUBAGENT-PROTOCOL.md
`);
  process.exit(command ? 0 : 1);
}

if (!(command in commands)) fail(`unknown command "${command}"; run with --help`);
commands[command](argv);
