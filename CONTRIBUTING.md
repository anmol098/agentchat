# Contributing to AgentChat

AgentChat is built by many agents and people working at the same time, each in their own git
worktree. That is why the process below is written down as precisely as it is: with several changes
in flight, "read the code and use your judgement" produces two agents editing the same file and a
board that no longer describes reality.

[`docs/SUBAGENT-PROTOCOL.md`](docs/SUBAGENT-PROTOCOL.md) is the normative document. This guide is the
practical path through it, and where the two disagree the protocol wins.

## Claim a task before you write anything

Work is one task, one file in [`docs/progress/tasks/`](docs/progress/tasks), one branch, one pull
request. The board is the schedule:

```bash
node scripts/board.mjs list --status todo --ready   # what is available and unblocked
node scripts/board.mjs show T-407                    # the full brief for one task
node scripts/board.mjs plan                          # the largest batch that can run in parallel
```

Claiming is the only operation with a race, so it has the strictest procedure. Run it from the
repository root on `main`, not from inside a worktree, and sync first:

```bash
node scripts/board.mjs claim T-407 --owner "<your-name>"
```

That edits exactly one file. Commit it and push to `main` — **the push is the lock**, and a rejected
push means somebody claimed something first. Do not force it; pull, re-check with
`board.mjs show`, and either retry or pick another task.

Three rules make the whole scheme work, and each has already been broken once at real cost:

- **One `in_progress` task at a time.** Finish or release before claiming another.
- **Touch only the paths in the task's `paths:` list.** If the work genuinely needs a file outside
  it, that is a signal to stop and escalate, not to widen scope. Silently widening scope is the most
  disruptive thing one contributor can do to a parallel build.
- **Board updates go straight to `main`**, never on the feature branch, so the board stays readable
  while work is in flight and a crashed agent still leaves an accurate trail.

Report as you go, with substance — "working on it" is not a log entry:

```bash
node scripts/board.mjs log T-407 "Quick start executed end to end except sign-in; /version is unregistered."
node scripts/board.mjs status T-407 in_review --pr 42
node scripts/board.mjs status T-407 blocked --reason "Needs the error-envelope shape from T-105."
```

[`docs/progress/BOARD.md`](docs/progress/BOARD.md) is **generated**. Edit the task file and run
`node scripts/board.mjs render`; a hand-edit will be overwritten and will fail `board.mjs check`.

## Local setup

You need Node ≥ 22.12 — the repository pins 24 in [`.nvmrc`](.nvmrc), and CI tests both LTS lines —
pnpm 10, and Docker for the Postgres the integration tests run against.

```bash
pnpm install
pnpm -r build
```

Work on a branch in a worktree, named `task/<ID>-<short-slug>`, lowercase and hyphenated:

```bash
git worktree add ../agentchat-T-407 -b task/T-407-readme-and-contributor-guide origin/main
```

Rebase on `origin/main` before opening a pull request, and never merge `main` into your branch;
history stays linear. Commit in logical steps rather than one commit at the end — a reviewer should
be able to read the branch commit by commit, and an interrupted session should not lose a day.

## The gates

These are gates, not preferences. A pull request that fails one will not be merged, and a red CI is
your task to fix rather than the reviewer's.

| Command | What it protects |
|---------|------------------|
| `pnpm format:check` | Biome formatting of the TypeScript and JSON sources |
| `pnpm lint` | Biome's linter: no `any`, no non-null assertions, no floating promises, no `@ts-ignore` |
| `pnpm typecheck` | `tsc --build` across every package plus each package's test project |
| `pnpm test` | The unit suite. Needs no database. |
| `pnpm test:integration` | The integration suite, against a real Postgres. See below. |
| `pnpm protocol:check` | The wire contract, diffed against `scripts/protocol-snapshot.json` |
| `node scripts/check-licenses.mjs` | The licence boundary, and the licences of `packages/` dependencies |
| `node scripts/lint-migrations.mjs` | Migration compatibility: no unguarded `DROP`, `RENAME`, `ALTER … TYPE`, `SET NOT NULL` |
| `node scripts/board.mjs check` | Board integrity: statuses, dependencies, path overlaps |

The first four are the ones to run constantly:

```bash
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
```

Integration tests run against a real PostgreSQL and never against a mock, because the schema
constraints are the thing under test. The development compose stack is the easiest way to get one:

```bash
docker compose up -d --wait postgres
export DATABASE_URL='postgres://agentchat:agentchat@localhost:5432/agentchat'
pnpm test:integration
```

`docker compose down` stops it and keeps the data; `docker compose down -v` destroys it.

The two script gates have self-tests, which are worth running if you change the script itself rather
than the code it checks:

```bash
node scripts/check-licenses.mjs selftest
node scripts/lint-migrations.mjs selftest
```

If a wire-protocol change is intentional and reviewed, `pnpm protocol:update` re-records the
snapshot. Updating it to make a red check green is the failure mode it exists to catch, so the diff
belongs in the pull request description.

## Code standards

The full list is [protocol §7.2–§7.4](docs/SUBAGENT-PROTOCOL.md#7-code-quality-standard). The ones
that come up most:

- **`strict` is on and stays on.** Never weaken a compiler option to make code compile. No `any`:
  use `unknown` and narrow. No non-null assertions on values that can actually be null.
- **Validate at the boundary.** Anything entering the server over HTTP or the WebSocket is parsed by
  a zod schema from `packages/protocol` before anything else touches it. Never trust a cast.
- **Respect the package graph.** `cli → client → protocol`, and `server → protocol`. No cycles and
  no reaching across; see the licence boundary below for why this one is not negotiable.
- **Errors are typed and carry a stable `code`.** Never throw a bare `Error` across a package
  boundary, and never let a database error reach the client unwrapped.
- **Tests ship in the same pull request as the behaviour.** Test the contract, not the
  implementation. Every rule of the form "X may do Y" gets a negative test proving that not-X may
  not, because an authorization rule with only a positive test is an authorization rule that has
  never been checked.
- **The stdout/stderr separation in `agentchat listen` has a dedicated test.** It is the contract
  that makes harness integration work: message payloads on stdout, every operational log on stderr.
  It must never regress.
- **No secrets, tokens, or credentials** in source, tests, fixtures, or logs.

## Commits and pull requests

[Conventional Commits](https://www.conventionalcommits.org), imperative mood, scoped to a package:

```text
feat(server): add project invite routes
fix(cli): keep operational logs off stdout in listen
test(server): cover cross-project send rejection
docs(protocol): document the hello frame
chore(board): claim T-407
```

The body explains **why**; the diff already says what. Reference the task as `Task: T-407`.

Before opening the pull request: rebase on `origin/main`, run the gates locally, and confirm the
task's acceptance criteria are each actually satisfied rather than approximately satisfied. Then
move the task along and say so on the board:

```bash
node scripts/board.mjs status T-407 in_review --pr 42
```

## Documentation moves with the code

These are gates too, and they are the ones most often forgotten:

- **A change to the wire protocol updates [`docs/protocol.md`](docs/protocol.md) in the same pull
  request.** Not a follow-up, not a task for later. The protocol document is what a self-hoster and
  a third-party client implementer read instead of the source, and a wire change that lands without
  it silently makes that document wrong for everyone downstream.
- **A change to a command's flags or output updates [`docs/cli.md`](docs/cli.md) in the same pull
  request.**
- **A decision that contradicts [the implementation plan](docs/IMPLEMENTATION-PLAN.md) updates the
  plan, or it did not happen.**

## The licence boundary

AgentChat is split-licensed: `packages/` (the CLI, the client library, the protocol definitions),
`examples/` and `scripts/` are MIT; `server/` and `deploy/` are AGPL-3.0-or-later; `docs/` is
CC BY 4.0. [`LICENSE`](LICENSE) is the authority.

The split is deliberate. The client half exists to be embedded — in agent harnesses, in other tools,
in commercial products — and copyleft there would defeat the point of an interoperable protocol. The
server half is copyleft so that hosted modifications come back to the people who depend on the
infrastructure.

**The combination creates a one-directional rule.** MIT code may be absorbed into an AGPL work; the
reverse is not true. So the dependency arrows only ever point one way:

```text
packages/protocol  (MIT)  ──▶ nothing
packages/client    (MIT)  ──▶ protocol
packages/cli       (MIT)  ──▶ client, protocol
server             (AGPL) ──▶ protocol
```

**Nothing under `packages/` may import, copy, or derive from anything under `server/`.** This is a
licensing boundary rather than an architectural preference: a single stray import would relicense
MIT code as AGPL by accident and break the guarantee the permissive half of this project makes to
everyone using it. [`scripts/check-licenses.mjs`](scripts/check-licenses.mjs) enforces it, and it
runs in CI on every push.

The same reasoning applies to dependencies. **A new dependency under `packages/` must be permissively
licensed** — MIT, ISC, BSD, or Apache-2.0. Copyleft dependencies belong under `server/` only. The
check verifies that too, and a bare `BSD` without a variant is rejected rather than assumed.

By contributing you agree that your contribution is licensed under the licence that applies to the
path you are changing.

## When to stop instead of guessing

Escalate — mark the task `blocked` with one specific sentence, and say so to whoever is
orchestrating — when any of these happen:

- the work needs files outside the task's `paths`;
- a dependency's output does not match what the task assumed;
- the implementation plan is ambiguous, wrong, or silent on something that changes the schema, the
  wire protocol, or the CLI's public surface;
- a security or data-loss concern surfaces;
- you are about to change something another `in_progress` task owns.

Never resolve ambiguity by inventing schema, protocol, or public API. Those are shared contracts, and
one contributor's guess becomes everyone else's bug.

If you find a real defect that is outside your task's paths, do not fix it. Record it in the task's
log and in the pull request so it can be scheduled:

```bash
node scripts/board.mjs log T-407 "GET /version answers 401: routes/version.ts is never registered in app.ts. Outside this task's paths; belongs to T-041."
```
