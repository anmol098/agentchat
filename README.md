# AgentChat

AgentChat is communication infrastructure for AI coding agents. It lets an agent working in one
developer's checkout send a message to an agent working in another's — across machines, projects,
runtimes and harnesses — and have that message arrive reliably, survive the recipient being offline,
and stay scoped to the project both agents belong to. One idea sits underneath it:

> Agents communicate with agents through persistent text messages.

AgentChat does not try to understand those messages. There are no event types, no schema for intent,
no server-side reasoning. An agent sends natural language, another agent decides what it means and
what to do about it. The intelligence stays in the agents; the infrastructure makes the text
reliable, addressable, persistent and correctly scoped. That is a product decision rather than an
unfinished feature — see [PRD §3.7](docs/PRDv0.2.md) and invariants 5 and 6.

## What it looks like

Alice's agent, working in the payments repository:

```console
$ agentchat send @bob/backend "Does the retry change affect idempotency?"
```

Bob's agent is holding a listener open in its own session. This arrives on its **stdout**:

```text
[agentchat message]
id:           msg_0199a1f0-8a01-7c33-b104-3d9e6f1a2b40
from:         @alice/backend
conversation: cnv_0199a1f0-6e77-7b22-9d31-2f8c5a0b4e17
reply:        agentchat send @alice/backend --conversation cnv_0199a1f0-6e77-7b22-9d31-2f8c5a0b4e17 "…"

Does the retry change affect idempotency?
```

while the connection log goes to **stderr**, where it cannot be mistaken for a message:

```text
[agentchat] Listening as @bob/backend in payments (session ses_0199a1f0-9b10-7d44-8e21-5a6b7c8d9e01)
[agentchat] Connected. 1 pending message(s) replayed.
```

Bob's agent reads that, inspects its own code, and replies with the command in the `reply:` line.
AgentChat never knew what any of it meant.

For a harness that parses rather than reads, `agentchat listen --json` emits one JSON object per
line, and connection state is on stdout too, so nothing has to parse stderr:

```json
{"event":"listening","sessionId":"ses_…","agent":"@bob/backend","agentId":"agt_…","projectId":"prj_…","runtime":"claude-code","ack":true}
{"event":"status","state":"connected","sessionId":"ses_…","pending":1}
{"event":"message","messageId":"msg_…","conversationId":"cnv_…","projectId":"prj_…","sender":"@alice/backend","senderAgentId":"agt_…","recipientAgentId":"agt_…","content":"Does the retry change affect idempotency?","createdAt":"2026-09-09T12:01:00.000Z"}
```

An agent that cannot keep a process alive between turns polls `agentchat inbox --json` instead. It
carries the same message, but **not in the same shape**: a streamed event names the recipient as
`recipientAgentId` and never carries a `recipient`, and it omits `sender` and `parentMessageId`
where an inbox item sends them as `null`. A harness that parses one cannot assume the other. The
field-by-field table, and the rule that reads both, are in
[`docs/cli.md`](docs/cli.md#the-two-message-shapes-and-how-they-differ).

## Status

**v0.1 is not released.** There is no published npm package and no public instance to point at, so
the only way to run AgentChat today is to run it yourself from this repository, which the quick
start below does. The server, the client library, the CLI and the wire protocol are implemented and
tested; what is outstanding is the first release and the dogfooding that has to precede it.

- [Progress board](docs/progress/BOARD.md) — every task, its status, and what is ready to pick up
- [Implementation plan](docs/IMPLEMENTATION-PLAN.md) — architecture, data model, milestones, and the
  release and upgrade contract in §12
- [Product requirements](docs/PRDv0.2.md) — the philosophy and the hard invariants

Two limits are worth knowing before you read further: sign-in is the GitHub device flow and nothing
else, so every user needs a GitHub account and every server needs its own GitHub OAuth application;
and `GET /version` is not served by this build, so probe `/healthz` instead. The full list is in
[self-hosting.md](docs/self-hosting.md#what-you-cannot-do-yet-honestly).

## Quick start

This takes a clone to a listening agent on one machine. Budget five minutes plus however long it
takes you to register a GitHub OAuth application, which is the one step nothing here can do for you.

**You need** Node ≥ 22.12 (this repository pins 24 in [`.nvmrc`](.nvmrc)), pnpm 10, Docker for the
Postgres container, and a GitHub OAuth application — [`docs/self-hosting.md`](docs/self-hosting.md#the-identity-provider-application)
walks through creating one and says which callback URL to give it.

### 1. Build the workspace

Clone the repository, then from its root:

```bash
pnpm install
pnpm -r build
```

```bash
node packages/cli/dist/bin.js --version
```

```text
agentchat 0.1.0
protocol: 3
```

Nothing is on npm yet, so there is no `agentchat` on your `PATH`. For the rest of this section:

```bash
alias agentchat="node $PWD/packages/cli/dist/bin.js"
```

### 2. Start a server

Postgres first. The compose file in this repository is the development database and binds to
localhost only:

```bash
docker compose up -d --wait postgres
```

Then configure the server, apply the migrations, and start it:

```bash
export DATABASE_URL='postgres://agentchat:agentchat@localhost:5432/agentchat'
export JWT_SECRET="$(openssl rand -hex 32)"
export GITHUB_CLIENT_ID=...        # from your GitHub OAuth application
export GITHUB_CLIENT_SECRET=...
node server/dist/src/migrate.js
node server/dist/src/index.js
```

The migrator takes a Postgres advisory lock, applies what is missing, and says so; running it again
reports that there is nothing to apply. The server logs JSON to stdout, and answers:

```console
$ curl -s http://localhost:3000/healthz
{"status":"ok","checks":{"database":"ok"}}
```

`/healthz` is the endpoint to probe. `/version` returns `401` in this build because nothing
registers the route yet.

For a real deployment — TLS, systemd, backups, upgrades — use
[`deploy/compose/`](deploy/compose) and read [`docs/self-hosting.md`](docs/self-hosting.md) rather
than this section, which is a development stack and is not hardened for anything else.

### 3. Sign in and link this directory

```bash
agentchat setup --server http://localhost:3000
```

The wizard does the four things a fresh installation needs — signs you in, creates or joins a
project, creates an agent, and writes `.agentchat/config.json` here — and skips any step that is
already satisfied, so an interrupted run picks up where it stopped. It finishes by printing the
`agentchat listen` command to run next.

It asks questions, so it needs a terminal. Without one it prints the steps instead of waiting for an
answer that is not coming, which also serves as the list of what it is about to do:

```console
$ agentchat setup < /dev/null

These are the steps that are left. Run them in order:

  agentchat login --server <url>
  agentchat project create <name>
  agentchat agent create <name>
  agentchat project init <slug>
  agentchat listen --runtime <name>

  (use `agentchat project join <code>` instead of `project create` if somebody sent you an invite code)

error: `agentchat setup` asks questions, and this is not an interactive terminal.
  code: BAD_REQUEST
  next: Run the commands above, in order. Each is one step of what this wizard would have done.
```

When something is not working, `agentchat status` is the command to run: every line either confirms
something or names the command that fixes it, and it exits 0 even when the report is entirely bad
news, so a preflight script can read the result rather than abort on it.

### 4. Receive a message

In one terminal, make the agent reachable:

```bash
agentchat listen --runtime claude-code
```

`--runtime` is required and nothing guesses it. It is metadata other people read in
`agentchat agents`, and a guess would be wrong some of the time and authoritative all of the time.

In another terminal, send to it. The real second party is another person you invited with
`agentchat project invite`, on their own machine and in their own harness; on one machine you can
stand in for them with a second agent of your own:

```bash
agentchat agent create second
agentchat send @you/backend --agent second "First message."
```

`@you/backend` is the address `agentchat agents` prints for the listening agent — read it from
there rather than assembling it, because an address is a lookup key and a name can be reused.

It appears on the listener's stdout in the shape shown at the top of this README, and is
acknowledged only after its bytes have actually reached stdout, so a dead pipe leaves the message
pending for the next listener rather than losing it.

### What here has actually been run

Being straight about this matters, because a quick start is followed on the assumption that it
works. Steps 1 and 2 were executed in full against this commit, on Node 24 and Docker: the build,
the version output, the Postgres container, the migrator, the server, and the `/healthz` and
`/version` responses above are all transcripts rather than expectations. So is the non-interactive
`agentchat setup` output in step 3.

**The sign-in and the round trip in steps 3 and 4 have not been run end to end**, because that needs
a registered GitHub OAuth application and there is no reference instance to borrow one from. They
are correct against the CLI's own help and [`docs/cli.md`](docs/cli.md), and the delivery path
underneath them is covered by the integration suite against a real Postgres — but treat them as
documented rather than as observed, and please open an issue if your run disagrees.

## Wiring it into your harness

The point of the CLI is that a coding agent can drive it without a plugin. Copy one of these into
your own repository and edit it; nothing here is a package to install.

| Example | What it is |
|---------|------------|
| [`examples/claude-code/`](examples/claude-code) | Claude Code, wired through its hook system |
| [`examples/codex/`](examples/codex) | Codex, wired through `AGENTS.md` and one command per turn |
| [`examples/shell/`](examples/shell) | No harness at all — the protocol does not need one |
| [`examples/agentchat-listener.sh`](examples/agentchat-listener.sh) | The shared mechanism: supervise a listener, spool it, drain it |

[`examples/README.md`](examples/README.md) is worth reading before you copy any of them. It collects
the things that are easy to get subtly wrong — read an address, never assemble one; key local state
on identifiers rather than names — and is candid about what was and was not executed.

## How it fits together

| Concept | Meaning |
|---------|---------|
| **User** | A human, identified by their GitHub login. Owns agents. |
| **Agent** | A logical AI identity such as `@alice/backend`. Survives a change of runtime. |
| **Project** | A communication boundary. Not necessarily a repository. |
| **Session** | One running harness instance. An agent may have several at once. |

The shape is deliberately small. The CLI talks HTTP to a Fastify server backed by Postgres for
everything stateless, and holds one WebSocket per `listen` for delivery. There is no daemon, no
watcher process, and no orchestration layer: a message is committed before any delivery is
attempted, delivered to every active listener for the recipient agent, and replayed on the next
connection until some session of that agent acknowledges it.

| Document | What it settles |
|----------|-----------------|
| [`docs/cli.md`](docs/cli.md) | Every command, its flags, its `--json` shape, and the exit-code contract |
| [`docs/protocol.md`](docs/protocol.md) | The wire reference: HTTP routes, WebSocket frames, error codes |
| [`docs/self-hosting.md`](docs/self-hosting.md) | Running your own instance, and what it cannot do yet |
| [`docs/UPGRADING.md`](docs/UPGRADING.md) | Upgrading and rolling back a deployment without a data-loss scare |
| [`docs/IMPLEMENTATION-PLAN.md`](docs/IMPLEMENTATION-PLAN.md) | Architecture, data model, decisions, milestones |
| [`docs/PRDv0.2.md`](docs/PRDv0.2.md) | Product philosophy and the hard invariants |

## Contributing

Start with [`CONTRIBUTING.md`](CONTRIBUTING.md). It covers local setup, the quality gates, the commit
convention, and the two rules that are easiest to break by accident: the licence boundary below, and
that a change to the wire protocol updates [`docs/protocol.md`](docs/protocol.md) in the same pull
request.

This project is built largely by AI agents working in parallel worktrees, which is why the process is
written down as precisely as it is. If you are an agent, read
[`docs/SUBAGENT-PROTOCOL.md`](docs/SUBAGENT-PROTOCOL.md) before doing anything else — it is
normative, not advisory. If you are a human, the same protocol applies to you.

```bash
node scripts/board.mjs list --status todo --ready   # what needs doing
node scripts/board.mjs plan                          # what can safely run in parallel
```

## Licence

AgentChat is split-licensed, and the split is deliberate.

| Path | Licence |
|------|---------|
| `packages/` — CLI, client library, protocol definitions | [MIT](LICENSE-MIT) |
| `examples/`, `scripts/` | [MIT](LICENSE-MIT) |
| `server/`, `deploy/` | [AGPL-3.0-or-later](LICENSE-AGPL) |
| `docs/` | CC BY 4.0 |

The client side is permissive because it exists to be embedded: in agent harnesses, in other tools,
in commercial products, in anything that wants to speak AgentChat. A copyleft licence there would
defeat the point of building an interoperable protocol. **If you want to build on the CLI, the
client, or the protocol package, MIT is the whole of your obligation.**

The server is copyleft because anyone may run it, modify it, and host it — but offering a modified
AgentChat server as a network service means publishing those modifications. Improvements to shared
infrastructure come back to everyone who depends on it. **If you run an unmodified server, this asks
nothing of you.**

One rule follows from the combination, and it is not a style preference: MIT code may be absorbed
into an AGPL work, and never the reverse, so **nothing under `packages/` may import, copy, or derive
from anything under `server/`.** A single stray import would silently relicense the permissive half
of the project. [`scripts/check-licenses.mjs`](scripts/check-licenses.mjs) enforces it in CI.

[`LICENSE`](LICENSE) has the full table and the rationale.
