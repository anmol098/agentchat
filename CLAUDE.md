# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgentChat is communication infrastructure for AI coding agents: an agent in one developer's checkout sends natural-language text to an agent in another's, and it arrives reliably, survives the recipient being offline, and stays scoped to a project. The server never interprets message content. That is the product, not a gap. See [docs/prd.md](docs/prd.md) sections 3.7 and 53 for the invariants.

pnpm workspace, TypeScript, ESM. Node 24 is pinned in `.nvmrc` (engines allow 22.12+; the shell's default Node may be 23, which `pnpm install` rejects, so run `nvm use` first in any fresh worktree). pnpm 10.

## Work is claimed on the board before it starts

Every change is one task file in `docs/progress/tasks/`, one branch, one pull request. [docs/subagent-protocol.md](docs/subagent-protocol.md) is normative; the short version:

```bash
node scripts/board.mjs list --status todo --ready     # what is available and unblocked
node scripts/board.mjs claim T-XXX --owner <name>     # edits one task file
git add docs/progress/tasks/T-XXX.md docs/progress/board.md
git commit -m "chore(board): claim T-XXX" && git push origin main   # the push is the lock
git worktree add ../agentchat-T-XXX -b task/T-XXX-<slug> origin/main
```

- Run every `board.mjs` command from the main checkout on `main`, never from inside a task worktree. A board commit made in a worktree lands on the task branch and has to be undone.
- Board updates (`log`, `status`) go straight to `main`, never on the feature branch.
- Touch only the paths the task declares. `node scripts/board.mjs scope T-XXX` lists what the branch changed and fails on anything outside them. Needing a file outside the list means stop and escalate (`status T-XXX blocked --reason "..."`), not widen scope.
- One `in_progress` task per agent. Commit in logical steps; an interrupted agent that has not committed loses everything.
- `docs/progress/board.md` is generated. Edit task files and run `node scripts/board.mjs render`.
- Pull requests are squash-merged. `main` requires the `ci`, `licences`, `protocol`, `migrations` and `upgrade` checks.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm -r build                       # tsc -b per package; CLI tests spawn dist/bin.js, so build before testing
pnpm format:check && pnpm lint && pnpm typecheck && pnpm test    # the pre-PR gate; CI runs the same plus integration
```

Tests are one Vitest install at the root with two projects, decided by filename: `*.integration.test.ts` needs PostgreSQL, everything else is `unit`.

```bash
pnpm test                                                   # unit project only
npx vitest run --project unit packages/cli/tests/listen.test.ts        # one file
npx vitest run --project unit packages/cli/tests/listen.test.ts -t "stdout"   # one test by name
docker compose up -d --wait postgres                         # dev database, localhost only
export DATABASE_URL='postgres://agentchat:agentchat@localhost:5432/agentchat'
pnpm test:integration                                        # integration project, serial, real Postgres
npx vitest run --project integration server/src/services/messages.integration.test.ts
```

Integration files share one database and run serially. Several agents running suites against the shared container has caused spurious failures before; a throwaway `postgres:18` container on another port is the clean answer.

Other gates, each also a CI job:

```bash
pnpm protocol:check          # wire contract vs scripts/protocol-snapshot.json; pnpm protocol:update to accept a reviewed change
node scripts/check-licenses.mjs        # nothing under packages/ imports server/; packages/ deps are permissive
node scripts/lint-migrations.mjs check # no unguarded DROP/RENAME/ALTER TYPE/SET NOT NULL in server/drizzle
node scripts/board.mjs check           # board integrity
./scripts/upgrade-test.sh all          # upgrade, rollback, skipped versions against real Postgres (needs docker + build)
```

Server from source (needs `DATABASE_URL`, `JWT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`; `PORT` defaults to 3000):

```bash
node server/dist/src/migrate.js        # advisory lock, applies what is missing, exit codes per sysexits (65 = schema ahead)
pnpm --filter @stackgrid/server dev    # tsx watch
node packages/cli/dist/bin.js --help   # the CLI from this checkout
```

New migration: edit `server/src/db/schema/*.ts`, then `pnpm --filter @stackgrid/server db:generate`. Migrations are forward-only and must keep the previous minor release runnable against the new schema (expand/contract; [docs/implementation-plan.md](docs/implementation-plan.md) section 12.3). A contract step carries a `-- contract-step: <release>` marker or the linter refuses it.

## Architecture

Four workspace members, and the dependency arrows are also a licence boundary: `packages/` is MIT, `server/` and `deploy/` are AGPL. `cli → client → protocol`, `server → protocol`, and nothing under `packages/` may import from `server/` (a stray import silently relicenses the permissive half; `check-licenses.mjs` fails the build).

**`packages/protocol`** is the wire contract: zod schemas for every HTTP body and WebSocket frame, typed IDs (`usr_`, `prj_`, `agt_`, `mch_`, `ses_`, `cnv_`, `msg_`, `inv_` + UUIDv7), the frozen error-code set, WebSocket close codes, `PROTOCOL_VERSION` and `MIN_CLIENT_VERSION`. Depends on zod only. Changes within a major are additive only; the snapshot check enforces it.

**`packages/client`** is `AgentChatClient`: `HttpTransport` over fetch, a `TokenManager` that refreshes once on 401 and retries, per-resource APIs, and the WebSocket listener with jittered reconnect that re-sends `hello`. `CredentialStore` is an interface; the package touches no filesystem.

**`packages/cli`** is the `agentchat` binary (npm package `@anmol098/agentchat`; the command and the package names differ on purpose). `command.ts` defines `CommandContext`: a command gets `emit` (stdout, JSON in `--json` mode, a rendering otherwise) and `log` (stderr only) and has no other route to stdout. That is how the contract "stdout carries payloads, stderr carries everything else" is enforced by types rather than review. Server, project and agent resolution each live in exactly one place (`config.ts` for the server, `context.ts` for project and agent). Exit codes are a public interface: 0, 1 generic, 2 usage, 3 auth required, 4 no project/agent.

**`server`** is Fastify. `app.ts` is the composition root. `plugins/auth.ts` verifies bearer JWTs; `routes/` handlers parse with protocol schemas, call a service, format output, and hold no business logic; `services/` own the rules and every authorization check, so a new caller cannot bypass one. `db/` is Drizzle: schema in `db/schema/`, SQL in `server/drizzle/`, and a migration runner with an advisory lock and a version guard that refuses a database newer than the image (exit 65) unless `AGENTCHAT_ALLOW_SCHEMA_AHEAD=true`.

**Delivery** (`server/src/routing/delivery.ts`, the module everything else exists to serve): `POST /messages` commits the row and a `message_inbox` row `pending` for `(recipient agent, project)`, then fans out to every socket the in-process registry holds for that pair. On `hello` the server replays everything still pending and then sends `ready`. Ack is agent-scoped: any session of the agent clears the debt for all of them. Delivery is at-least-once; duplicates are expected and clients dedupe on `messageId`. Sessions go `active` → `stale` (no heartbeat for 60 s) → `ended`; a `hello` revives a stale session, which is what makes reconnection work at all.

**WebSocket** (`server/src/websocket/`): the upgrade checks the client version floor, then the token; the first frame must be `hello`; frames are validated with protocol schemas; unknown frame types are ignored. Frame `type` is a transport operation only. There is no semantic frame type and there never will be.

## Things that are contracts, not style

- The server never reads message content beyond its byte length. No event taxonomy, no server-side reasoning.
- `agentchat listen` writes only message payloads (or NDJSON events with `--json`) to stdout; every operational line goes to stderr. `packages/cli/tests/listen.test.ts` asserts it.
- Shared contracts (database schema, wire protocol, public CLI surface) are decided in [docs/implementation-plan.md](docs/implementation-plan.md) first, then implemented. Decisions live in its section 0 table. If the plan is silent or wrong, escalate rather than guess.
- A wire change updates [docs/protocol.md](docs/protocol.md) in the same pull request; `server/tests/protocol-doc.test.ts` reads its headings and tables. A CLI change updates [docs/cli.md](docs/cli.md); `packages/cli/tests/cli-doc.test.ts` reads its command headings and reproduces its offline `--json` transcripts.
- One version number across every package, released by pushing `vX.Y.Z`. `deploy/compose/.env.example` pins that version and the release preflight refuses a tag it does not name. A `workflow_dispatch` of the release workflow from a branch is a dry-run rehearsal and can never publish.
- Documentation files are lower-case kebab-case (root `README.md`, `CONTRIBUTING.md`, `CLAUDE.md`, `LICENSE*` excepted). Cross-references say "section 4.2", never the section sign. Operator documents (`docs/self-hosting.md`, `docs/upgrading.md`, `docs/cli.md`, `deploy/compose/README.md`) do not cite the plan, the PRD, decision numbers or task IDs; the reasoning is stated in the reader's terms.

## Where things are written down

| Document | What it settles |
|----------|-----------------|
| [docs/subagent-protocol.md](docs/subagent-protocol.md) | Claiming, worktrees, reporting, definition of done, escalation |
| [docs/progress/board.md](docs/progress/board.md) | Every task and its status (generated) |
| [docs/progress/needs-attention.md](docs/progress/needs-attention.md) | Maintainer decisions and lessons from the build |
| [docs/implementation-plan.md](docs/implementation-plan.md) | Locked decisions, data model, API, delivery algorithm, release strategy |
| [docs/prd.md](docs/prd.md) | Product philosophy and the ten invariants |
| [docs/system-design.md](docs/system-design.md) | The whole system drawn: components, deployment, data model, flows, state machines, interface tables |
| [docs/protocol.md](docs/protocol.md) | The wire reference, test-guarded |
| [docs/cli.md](docs/cli.md) | Every command, flag, JSON shape and exit code, test-guarded |
| [docs/self-hosting.md](docs/self-hosting.md), [docs/upgrading.md](docs/upgrading.md), [deploy/compose/](deploy/compose) | Running and upgrading an instance |
| [examples/](examples) | Harness integrations for Claude Code, Codex, and plain shell |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The human-readable path through the protocol, commit convention, file naming |
