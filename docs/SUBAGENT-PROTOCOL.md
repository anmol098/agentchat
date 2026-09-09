# Subagent Protocol

**Status:** Normative. Every agent working in this repository must follow it.
**Applies to:** AI coding agents (Claude Code, Codex, OpenCode, …) and human contributors working in parallel worktrees.
**Companion documents:** [Progress board](./progress/BOARD.md) · [Implementation plan](./IMPLEMENTATION-PLAN.md) · [PRD](./PRDv0.2.md)

---

## 1. Why this protocol exists

AgentChat is built by many agents working at the same time, each in its own git worktree. Without a shared protocol, three failures are guaranteed: two agents pick the same task, two agents edit the same file and produce an unmergeable branch, and the board drifts out of sync with reality.

The protocol solves those three problems with three rules:

1. **One file per task.** An agent writes only to its own task file, so board updates never conflict.
2. **The claim is a push to `main`.** Git's atomic ref update is the lock. Losing the race is a failed push, not a corrupted board.
3. **Every task declares the paths it owns.** Two tasks whose paths overlap are never scheduled in parallel.

Everything below follows from those three rules.

---

## 2. Vocabulary

| Term | Meaning |
|------|---------|
| **Orchestrator** | The session that plans, schedules, and reviews. Usually the human's main session. It does not write feature code. |
| **Subagent** | An agent executing exactly one task in its own worktree. |
| **Task** | One unit of work, one file in `docs/progress/tasks/`, one branch, one pull request. |
| **Board** | `docs/progress/BOARD.md`. Generated from task files. Never hand-edited. |
| **Owned paths** | The `paths:` list in a task's frontmatter. The only files that task may create or modify. |

---

## 3. Task lifecycle

```text
  todo ──claim──▶ in_progress ──open PR──▶ in_review ──merge──▶ done
                       │
                       ├──blocked──▶ blocked ──unblock──▶ in_progress
                       └──abandon──▶ todo        (owner cleared, log entry required)
```

A task is in exactly one status. `blocked` and `todo` are the only statuses an agent may leave a task in when it stops working.

---

## 4. Claiming a task

Claiming is the only operation with a race, so it has the strictest procedure. **Run it from the repository root on `main`, never from inside a worktree.**

```bash
# 1. See what is available. Never claim a task whose dependencies are not `done`.
node scripts/board.mjs list --status todo --ready

# 2. Sync. A stale board is the most common cause of a lost race.
git checkout main && git pull --rebase origin main

# 3. Claim. This edits exactly ONE file.
node scripts/board.mjs claim T-101 --owner "<your-agent-name>"

# 4. Commit and push. The push is the lock.
git add docs/progress/tasks/T-101.md docs/progress/BOARD.md
git commit -m "chore(board): claim T-101"
git push origin main
```

**If step 4 is rejected**, another agent claimed something first. Do not force push. Run:

```bash
git pull --rebase origin main
node scripts/board.mjs show T-101
```

If the task now has a different owner, you lost the race. Reset your claim and pick another task. If it is still `todo`, retry the push. Never retry more than three times; if you keep losing, report to the orchestrator that the board is contended.

**Rules**

- Hold **at most one** `in_progress` task at a time. Finish or release before claiming another.
- Never claim a task whose `depends_on` entries are not all `done`. The `--ready` filter enforces this.
- Never claim a task whose `paths` overlap a task that is currently `in_progress`. `scripts/board.mjs claim` refuses this and names the conflicting task.
- Claiming is not permission to redesign. If the task's approach looks wrong, see §9.

---

## 5. Working in a worktree

One task, one worktree, one branch.

```bash
git worktree add ../agentchat-T-101 -b task/T-101-users-projects-schema origin/main
cd ../agentchat-T-101
pnpm install
```

Branch naming is `task/<ID>-<short-slug>`, lowercase and hyphenated.

**While working**

- Namespace anything you write to a shared scratchpad with your task id. Several agents run at once, and a generic filename such as `pr.md` will be overwritten mid-task by someone else's draft. This has already happened.

- Touch only the files in the task's `paths`. If the work genuinely requires a file outside that list, stop and follow §9. Silently widening scope is the single most disruptive thing an agent can do to a parallel build.

- Check that you have not, before you open the pull request and again whenever you are about to touch something new:

  ```bash
  node scripts/board.mjs scope T-101
  ```

  It lists every file your branch has changed, committed or not, and fails on anything outside your declared paths. Your own task file, `BOARD.md` and `docs/protocol.md` are always allowed, and a declared source file covers its sibling tests.

  This is not a formality. `check` proves that declared paths do not overlap; nothing proves they are *complete*, so a path nobody declares collides with nothing and two agents can edit the same file for an hour with every other board command reporting success. That has already happened here.
- Rebase on `origin/main` at least once a day and before opening a pull request. Never merge `main` into your branch; keep history linear.
- Commit in logical steps, not one giant commit at the end. A reviewer should be able to read the branch commit by commit.
- Never commit a `node_modules`, a build artefact, a `.env`, a credential, or an editor directory.

**When finished**

```bash
cd /path/to/agentchat
git worktree remove ../agentchat-T-101
```

Remove the worktree only after the pull request is merged.

---

## 6. Reporting progress

Progress lives in the task file, appended to its `## Log` section. Because a task file has exactly one writer, these commits never conflict.

```bash
node scripts/board.mjs log T-101 "Schema and migration written; integration test still failing on the partial unique index."
git add docs/progress/tasks/T-101.md docs/progress/BOARD.md
git commit -m "chore(board): progress on T-101"
git push origin main
```

Log an entry when you claim, when the status changes, when you discover something that affects another task, and when you stop for any reason. A log entry is one or two sentences of substance. "Working on it" is not a log entry.

Status changes use the same mechanism:

```bash
node scripts/board.mjs status T-101 in_review --pr 42
node scripts/board.mjs status T-101 blocked --reason "Needs the error-envelope shape from T-105."
```

**Board updates always go straight to `main`.** They are never part of the feature branch. This keeps the board readable while work is in flight and means a crashed agent still leaves an accurate trail.

---

## 7. Code quality standard

These are gates, not preferences. A pull request that fails any of them will not be merged.

### 7.1 Automated gates

Every pull request must pass, and you must run them locally before opening one:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```

CI runs the same commands plus integration tests against a real Postgres. A red CI is your task to fix, not the reviewer's.

### 7.2 TypeScript

- `strict` is on and stays on. Never weaken a compiler option to make code compile.
- No `any`. Use `unknown` and narrow. If `any` is genuinely unavoidable, it carries a `// eslint-disable`-style comment naming the reason on the same line.
- No non-null assertions (`!`) on values that can actually be null. Handle the null.
- Every exported symbol from `packages/protocol`, `packages/client`, and every server service has a TSDoc comment stating what it does and what it throws.
- Validate at the boundary. Data entering the server from HTTP or WebSocket is parsed by a zod schema from `packages/protocol` before anything else touches it. Never trust a cast.

### 7.3 Structure

- Respect the package boundaries in the implementation plan. `cli` depends on `client` and `protocol`. `client` depends on `protocol`. `protocol` depends on nothing but zod. The server depends on `protocol`. No cycles, no reaching across.
- No business logic in route handlers. A handler parses input, calls a service, and formats output. Authorization checks live in the service layer so they cannot be bypassed by a new caller.
- Errors are typed and carry a stable `code` string. Never throw a bare `Error` across a package boundary, and never let a database error reach the client unwrapped.
- No secrets, tokens, or credentials in source, tests, fixtures, or logs.

### 7.4 Tests

- Every task that changes behaviour ships tests in the same pull request. A task is not done because the code exists.
- Test the contract, not the implementation. A test that breaks on every refactor is a liability.
- Authorization gets negative tests. For every rule of the form "X may do Y", there is a test proving that not-X may not.
- Integration tests run against real Postgres, never a mock, because the schema constraints are the thing under test.
- The stdout/stderr separation in `agentchat listen` has a dedicated test. It is the contract that makes harness integration work and it must never regress.

### 7.5 Commits

Conventional Commits, imperative mood, scoped to a package:

```text
feat(server): add project invite routes
fix(cli): keep operational logs off stdout in listen
test(server): cover cross-project send rejection
chore(board): claim T-101
docs(protocol): document the hello frame
```

The body explains why, not what. The diff already says what. Reference the task as `Task: T-101` in the body.

### 7.6 Documentation

- A change to the wire protocol updates `docs/protocol.md` in the same pull request.
- A change to a command's flags or output updates `docs/cli.md` in the same pull request.
- A decision that contradicts the implementation plan updates the plan, or it did not happen.

---

## 8. Definition of done

A task moves to `done` only when all of these hold:

1. Acceptance criteria in the task file are each satisfied, and the file's checklist is ticked.
2. All automated gates pass in CI.
3. Tests covering the new behaviour exist and are meaningful.
4. Documentation affected by the change is updated in the same pull request.
5. The pull request is reviewed and merged into `main`.
6. The task's owned `paths` were respected, or the deviation was approved and recorded in the log.
7. The worktree is removed and the branch deleted.

---

## 9. Escalation

Stop and escalate to the orchestrator instead of guessing when any of these happen:

- The work needs files outside the task's `paths`.
- A dependency's output does not match what this task assumed.
- The implementation plan is ambiguous, wrong, or silent on a decision that changes the schema, the wire protocol, or the CLI's public surface.
- A security or data-loss concern surfaces.
- You are about to change something another `in_progress` task owns.

To escalate:

```bash
node scripts/board.mjs status T-101 blocked --reason "<one specific sentence>"
git add docs/progress/tasks/T-101.md docs/progress/BOARD.md
git commit -m "chore(board): block T-101 pending error-envelope decision"
git push origin main
```

Then report to the orchestrator with the task ID, what you tried, and the specific decision you need. A blocked task with a vague reason is worse than no report, because it costs someone else a full investigation to recover your context.

**Never** resolve ambiguity by inventing schema, protocol, or public API. Those are shared contracts and one agent's guess becomes everyone else's bug.

---

## 10. Rules for the orchestrator

- Schedule only tasks whose `paths` are disjoint. `node scripts/board.mjs plan` prints the largest safe parallel batch.
- **Run `node scripts/board.mjs scope <ID>` in a branch's worktree before merging it, and treat a failure as a review finding rather than a nuisance.** `plan` and `check` reason about what a task *said* it would touch. Only this reasons about what it did. A task that reaches outside its paths has already invalidated the scheduling decision that let something else run beside it, and you will not learn that from the board.
- Give each subagent the task ID and nothing else it does not need. The task file is the brief.
- Review against §7 and §8 before merging. Approving a pull request that skips tests teaches every later agent that tests are optional.
- Keep the board honest. Sweep stale `in_progress` tasks whose owner has gone silent, and return them to `todo` with a log entry explaining what was salvaged.
- **Remove only the worktree whose work you just merged, by name.** A loop over every agent worktree will delete the uncommitted work of agents still running. This has already destroyed a task's work once: the agent had written its service and routes, had committed nothing, and the directory went with the sweep. Removing a worktree is not reversible by anything git offers, because unstaged files leave no objects behind.
- Never let a subagent redefine a shared contract unilaterally. Decisions go into the implementation plan first, then into code.

---

## 11. Quick reference

```bash
node scripts/board.mjs list --status todo --ready       # what can I pick up?
node scripts/board.mjs plan                              # largest safe parallel batch
node scripts/board.mjs show T-101                        # full task detail
node scripts/board.mjs claim T-101 --owner backend-1     # take it (then commit + push)
node scripts/board.mjs log T-101 "<what happened>"       # append progress
node scripts/board.mjs status T-101 in_review --pr 42    # move it along
node scripts/board.mjs status T-101 blocked --reason "…" # escalate
node scripts/board.mjs check                             # validate board integrity (runs in CI)
node scripts/board.mjs render                            # regenerate BOARD.md
```
