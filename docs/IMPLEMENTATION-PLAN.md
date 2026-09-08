# AgentChat — Technical Implementation Plan

**Status:** Draft v3 (2026-09-08)
**Source PRD:** [PRDv0.2.md](./PRDv0.2.md)
**Target:** v0.1 MVP as defined in PRD §47 / §55

---

## 0. Decisions locked (supersede PRD where they conflict)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **No daemon in v0.1.** `agentchat listen` holds its own WebSocket; every other command is a stateless HTTP call. | Removes IPC, process lifecycle, and OS service management from the critical path. A `Transport` interface in `packages/client` keeps the daemon slot open for v0.2. |
| D2 | **Fan-out delivery.** A message to `(agent, project)` is delivered to every active listener session for that pair. | Simplest at-least-once model; harness dedupes on `messageId`. |
| D3 | **Ack is agent-scoped, not session-scoped.** A message is `pending` for an agent+project until *any* session of that agent acks it. Per-session delivery rows exist for diagnostics only. | Sessions are ephemeral (created per `listen`), so replay must key on the durable identity. See §4.3. |
| D4 | **GitHub OAuth device flow** for login. Server mints its own access + refresh tokens; GitHub is only used to establish identity. | No email infra, no password storage, natural `@username`. Protocol stays IdP-agnostic (PRD §30). |
| D5 | **Direct agent-to-agent only.** `recipient_agent_id` is required. | Broadcast deferred; adding a nullable recipient later is additive. |
| D6 | **Postgres** via Drizzle. Reference deployment is a **single dedicated VM (EC2) running Docker Compose**, with Postgres either in the compose stack or on RDS. | No request-timeout caps on WebSockets, no scale-to-zero, and the exact same artefact self-hosters run. See §8 M5 and §12. |
| D7 | Binary and npm package are both **`agentchat`** (name confirmed free on npm on 2026-09-08). All lowercase everywhere, including `.agentchat/` config dir. | CLI convention. |
| D8 | **CLI only** as the agent integration surface in v0.1. `--json` on all read commands and `listen --json`. MCP server is a v0.2 thin wrapper over `packages/client`. | PRD §46. |
| D9 | Target audience for v0.1: **author + 1–2 collaborators dogfooding** across two machines. | No rate limiting, admin UI, or abuse controls in v0.1. |
| D10 | **Message content limit is 1 MiB** of UTF-8. | 64 KiB was judged too small; will be revisited when file sharing is designed. |
| D11 | **Any project member can create invites.** Only owners can rename/delete the project. | Keeps onboarding frictionless for small teams. |
| D12 | **`.agentchat/config.json` is committed** to the repo. It holds only `projectId`/`projectSlug`. | Every clone resolves the same project (PRD §14). |
| D13 | **Agent deletion is in v0.1** as a soft delete. | Messages must keep referencing historical senders. |
| D14 | **`listen --runtime <name>` is required.** No environment sniffing. | The invoking agent knows its own runtime; guessing produces wrong metadata. |
| D15 | **Reads are restricted** to messages where one of the caller's own agents is sender or recipient. | Default from plan v1, confirmed. |
| D17 | **List responses are enveloped** as `{ items: [...] }`, not bare arrays. Project slugs use the same grammar as agent names, `^[a-z0-9][a-z0-9-]{0,31}$`. | A bare array cannot carry a pagination cursor, so adding one would be a major-version change under D-additive rules. Decided during T-201, while no client existed and the cost was one level of nesting. |
| D16 | **Split licence.** `packages/` (CLI, client, protocol) is MIT; `server/` and `deploy/` are AGPL-3.0-or-later. | The client half must be embeddable in any harness or product; the server half should return hosted modifications to the community. Imposes a hard rule: nothing in `packages/` may depend on `server/`. See [LICENSE](../LICENSE). |

---

## 1. Repository layout

pnpm workspaces + TypeScript project references. ESM throughout, **Node ≥ 22.12** (raised from 20 during T-001: Node 20 is end-of-life and Node 23 is a non-LTS line the test runner rejects, leaving the 22 and 24 LTS lines; local development pins to 24).

```text
agentchat/
├── packages/
│   ├── protocol/        # zod schemas + TS types for HTTP bodies, WS frames, IDs. Zero runtime deps beyond zod.
│   ├── client/          # AgentChatClient: HTTP (fetch) + WS (ws) with reconnect/backoff, auth token refresh, Transport interface
│   └── cli/             # `agentchat` binary (commander). Depends on client + protocol only.
├── server/              # Fastify app. api/ websocket/ services/ persistence/ auth/ routing/
├── docs/                # PRD, this plan, protocol.md, cli.md
├── examples/            # harness snippets: CLAUDE.md / AGENTS.md instructions for keeping a listener alive
├── docker-compose.yml   # local Postgres
├── Dockerfile           # server image
├── pnpm-workspace.yaml
├── tsconfig.base.json
└── package.json
```

Deviations from PRD §50: no `packages/daemon` (D1), no `packages/shared` (`protocol` is the shared package). `tests/` lives inside each package rather than at the root.

**The package boundary is also a licence boundary** (D16). `packages/` is MIT and `server/` is AGPL, so the dependency arrows only ever point from the server into `protocol`, never the other way. T-009 enforces this in CI, because a single stray import would relicense MIT code by accident.

**Toolchain**

| Concern | Choice |
|---------|--------|
| Package manager | pnpm 10 (already installed) |
| Build | tsup for `cli` and `client`; `tsc -b` for type-check; server runs via `tsx` in dev, tsup for image |
| Test | vitest; integration tests against docker Postgres |
| Lint/format | biome |
| CI | GitHub Actions: lint, typecheck, unit, integration (services: postgres) |
| Server framework | Fastify 5 + `@fastify/websocket` |
| Validation | zod (shared via `protocol`) |
| ORM / migrations | Drizzle + `drizzle-kit` |
| Logging | pino (server), stderr-only logger in CLI |
| IDs | UUIDv7 with type prefixes: `usr_`, `prj_`, `agt_`, `mch_`, `ses_`, `cnv_`, `msg_`, `inv_` |

---

## 2. Data model (server)

Matches PRD §51 with the changes marked **(new)** or **(changed)**.

```text
users              id, github_id (unique), username (unique, lowercase), display_name, email?, created_at
projects           id, slug (unique), name, created_by, created_at
project_members    project_id, user_id, role ('owner'|'member'), created_at        PK(project_id,user_id)
project_invites    id, project_id, code (unique, e.g. ANET-7K4M-Q2P9), created_by, expires_at, max_uses?, uses, revoked_at?   (new)
agents             id, user_id, name, created_at, updated_at, deleted_at?              UNIQUE(user_id, name) WHERE deleted_at IS NULL
agent_projects     agent_id, project_id, created_at                                   PK(agent_id,project_id)
machines           id, user_id, name (hostname), created_at, last_seen_at
sessions           id, agent_id, project_id, machine_id, runtime?, working_directory, started_at, last_seen_at, ended_at?, status ('active'|'stale'|'ended')
conversations      id, project_id, created_at
messages           id, project_id, conversation_id, parent_message_id?, sender_agent_id, recipient_agent_id,
                   content (text, ≤ 1 MiB, D10), client_message_id (unique per sender)  (new), created_at
message_inbox      message_id, agent_id, project_id, status ('pending'|'acked'), acked_at?, acked_by_session_id?   (new, D3)   PK(message_id,agent_id)
deliveries         message_id, session_id, delivered_at, acked_at?                    (diagnostics only)   PK(message_id,session_id)
refresh_tokens     id, user_id, token_hash, created_at, expires_at, revoked_at?, machine_id?
```

Notes

- `username` comes from GitHub login; `@alice/backend` = `users.username` + `/` + `agents.name`. Agent names: `^[a-z0-9][a-z0-9-]{0,31}$`.
- `client_message_id` is generated by the CLI per `send` invocation so a retried HTTP POST cannot create a duplicate row.
- `sessions.status` transitions: `active` → `stale` when no heartbeat for 60 s → `ended` on explicit DELETE or after 24 h stale. Presence = "agent has ≥ 1 `active` session in this project".
- Agent soft delete (D13): sets `deleted_at`, ends all its sessions, removes `agent_projects` rows, and rejects it as a recipient. Existing messages keep their `sender_agent_id`/`recipient_agent_id`; discovery and `@user/agent` resolution exclude deleted agents. The name becomes reusable (partial unique index).
- Body limits: Fastify `bodyLimit` and the WS `maxPayload` are both 2 MiB so a 1 MiB message plus JSON envelope fits.
- Every migration must follow the compatibility rules in §12.3 so an operator can roll the server image back one version without touching the database.
- Authorization invariants (PRD §31) enforced in the service layer:
  - sender agent must be owned by the caller **and** be in the project;
  - recipient agent must be in the project;
  - callers can only read messages where one of their own agents is sender or recipient.

---

## 3. HTTP API (server)

All bodies/responses are zod schemas in `packages/protocol`. Bearer token auth on everything except `/auth/device/*` and `/healthz`.

```text
Auth
  POST /auth/device/start            → { deviceCode, userCode, verificationUri, interval, expiresIn }
  POST /auth/device/poll             { deviceCode } → 428 pending | { accessToken, refreshToken, user }
  POST /auth/refresh                 { refreshToken } → { accessToken, refreshToken }
  POST /auth/logout                  { refreshToken }
  GET  /me
  GET  /version                      → { version, protocolVersion, minClientVersion }   (unauthenticated, see §12.4)

Projects
  GET  /projects
  POST /projects                     { name, slug? }
  GET  /projects/:id
  POST /projects/:id/invites         → { code, expiresAt }          (any member, D11; default expiry 7 d)
  GET  /invites/:code                → { project, invitedBy }        (preview before join, PRD §27)
  POST /invites/:code/join
  DELETE /projects/:id/invites/:inviteId   (revoke; see T-014)
  POST /projects/:id/leave
  GET  /projects/:id/agents          → [{ agent, owner, online, sessions: n }]   (discovery, PRD §21)

Agents
  GET  /agents                       (mine)
  POST /agents                       { name }
  PATCH /agents/:id                  { name }
  DELETE /agents/:id                 (soft delete, D13)
  POST /agents/:id/projects          { projectId }
  DELETE /agents/:id/projects/:pid

Sessions
  POST /sessions                     { agentId, projectId, machine:{name}, runtime?, workingDirectory } → { sessionId }
  POST /sessions/:id/heartbeat       (fallback if WS pings are not enough; WS is primary)
  DELETE /sessions/:id
  GET  /sessions?projectId=&agentId= (diagnostics for `agentchat status`)

Messages
  POST /messages                     { projectId, senderAgentId, recipientAgentId, content, conversationId?, parentMessageId?, clientMessageId }
  GET  /messages?projectId=&agentId=&status=pending|all&since=&limit=   (inbox)
  POST /messages/:id/ack             { agentId, sessionId? }
  GET  /conversations/:id            → { conversation, messages[] }
```

Errors are `{ error: { code, message } }` with stable `code` strings so the CLI can render them and `--json` consumers can branch on them.

List responses are `{ items: [...] }` rather than bare arrays (D17), so pagination can be added as an optional field instead of a breaking change to the top-level type.

`GET /healthz` is deliberately outside this contract: it reports whether a process should receive traffic, to an orchestrator deployed alongside it, and its body is a status document rather than the error envelope. It is the only such route, and it is not the pattern to copy for anything here (T-013). Every route in this table takes its bodies from `packages/protocol` and its failures from the frozen error set.

---

## 4. Real-time protocol (WebSocket)

Endpoint: `GET /ws` with `Authorization: Bearer` header (or `?token=` fallback for clients that cannot set headers).

### 4.1 Frames (client → server)

```jsonc
{ "type": "hello",  "sessionId": "ses_…" }                // must be first frame; binds this socket to a registered session
{ "type": "ack",    "messageId": "msg_…" }
{ "type": "ping" }
```

### 4.2 Frames (server → client)

```jsonc
{ "type": "ready",   "sessionId": "ses_…", "pending": 3 }
{ "type": "message", "message": { messageId, projectId, conversationId, parentMessageId, senderAgentId, sender: "@alice/backend", recipientAgentId, content, createdAt } }
{ "type": "pong" }
{ "type": "error",   "code": "…", "message": "…" }
```

`type` is a transport operation only (PRD §34/§35). There will never be a semantic frame type.

### 4.3 Delivery algorithm (server)

```text
on POST /messages:
  insert messages row
  insert message_inbox (message, recipient_agent, project) status=pending
  for each socket in registry[(recipient_agent, project)]:
      send {type:"message"}; insert deliveries row

on hello(sessionId):
  validate session belongs to caller and is active; add socket to registry[(agent, project)]
  replay: SELECT messages JOIN message_inbox WHERE agent=? AND project=? AND status='pending' ORDER BY created_at
  send each; insert deliveries rows; send {type:"ready", pending:n}

on ack(messageId):
  UPDATE message_inbox SET status='acked', acked_at=now(), acked_by_session_id=? WHERE message_id=? AND agent=? AND status='pending'
  UPDATE deliveries SET acked_at=now() WHERE message_id=? AND session_id=?

heartbeat: server pings every 20 s; no pong in 60 s → close socket, mark session stale.
```

Registry is an in-process `Map<agentId:projectId, Set<Socket>>`. Single server process is enough for v0.1. Fan-out across multiple server instances (Postgres `LISTEN/NOTIFY` or Redis pub/sub) is a v0.2+ item and is isolated behind a `Router` interface.

### 4.4 At-least-once guarantees

- A message row is committed before any delivery attempt.
- Replay on every `hello` covers: recipient offline at send time, socket drop mid-delivery, listener crash before ack.
- Duplicates are possible (e.g. ack lost). Listener dedupes by `messageId` in-process; harness is told to treat `messageId` as idempotency key (PRD §24).

---

## 5. Client package (`packages/client`)

```ts
interface Transport {                     // D1: daemon slots in here later
  request<T>(method, path, body?): Promise<T>
  connect(sessionId): AsyncIterable<ServerFrame> & { send(frame): void; close(): void }
}
class AgentChatClient {
  constructor(opts: { baseUrl, credentials: CredentialStore })
  auth, projects, agents, sessions, messages   // typed wrappers over protocol schemas
  listen(sessionId, { onMessage, onStatus }): Listener   // reconnect w/ jittered backoff (1s → 30s cap), re-sends hello, auto-refreshes access token on 401
}
```

- Fetch-based HTTP; `ws` for sockets.
- Token refresh: on 401, refresh once, retry once, else surface `AUTH_REQUIRED`.
- No filesystem access in this package; `CredentialStore` is an interface implemented by the CLI.

---

## 6. CLI (`packages/cli`, binary `agentchat`)

### 6.1 Local configuration

```text
~/.config/agentchat/credentials.json     mode 0600  { accessToken, refreshToken, user, serverUrl }
~/.config/agentchat/config.json                     { serverUrl, defaultAgentByProject: { prj_x: "agt_y" } }
<repo>/.agentchat/config.json            committable { projectId: "prj_…", projectSlug: "payments" }
```

Resolution order for **server**: `--server` flag → `AGENTCHAT_SERVER` env → `serverUrl` in user config → the build's `BUILT_IN_SERVER_URL` → usage error with hint.
Resolution order for **project**: `--project` flag → `AGENTCHAT_PROJECT` env → nearest `.agentchat/config.json` walking up from cwd → error `NO_PROJECT` with hint.
Resolution order for **agent**: `--agent` flag → `AGENTCHAT_AGENT` env → `defaultAgentByProject[projectId]` → if the user has exactly one agent in the project, use it → error `NO_AGENT` with hint.

All three are resolved in exactly one place each and by every command: server in `config.ts`, project and agent in `context.ts`. A second copy is a defect, not a shortcut — two copies of the server resolution had already drifted on whitespace handling before there was a third command to disagree (T-024, T-026).

Agent selection deliberately lives in *user* config, not the repo config: the repo is shared, the agent is personal (PRD §15).

#### What a fresh install points at (T-026)

`BUILT_IN_SERVER_URL` is **`null` in the published build**, and nothing in the CLI guesses a host. A default server decides whose machine receives a device-authorization request and ends up holding a user's tokens, so it may only ever name a host the people shipping the build control; the reference instance is M5 work and does not exist yet.

What makes a clean machine usable instead is that **`agentchat login` records the server it signed in to** in `~/.config/agentchat/config.json`. The address is supplied once and no later command needs `--server`. A failed or abandoned login records nothing, so a typo does not become permanent, and `logout` leaves the recorded address in place to log back in to.

**A self-hoster's instruction to their users is therefore one line:**

```sh
agentchat login --server https://chat.your-company.example
```

A distribution that wants no flag at all — the reference deployment when M5 lands, or a self-hoster building the CLI for their own people — sets `BUILT_IN_SERVER_URL` in `packages/cli/src/config.ts`. That is the "Set `serverUrl` default in the CLI build" line in M5 below, and it is a one-constant change: the resolution step and its tests already exist. A built-in default is deliberately never written into user config, so changing it later reaches everybody rather than only people who have never logged in.

`agentchat setup` (T-403) is a friendlier front door onto the same storage, not a prerequisite for it.

### 6.2 Commands

```text
agentchat login | logout | whoami
agentchat setup                               # wizard: login → create/join project → create agent → write .agentchat/config.json (PRD §54)

agentchat project list
agentchat project create <name>
agentchat project invite [--expires 7d]       # prints code
agentchat project join <code>                 # preview + confirm (PRD §27)
agentchat project leave
agentchat project init <slug|id>              # writes .agentchat/config.json in cwd
agentchat project current

agentchat agent list
agentchat agent create <name> [--project …]   # creates + joins current project
agentchat agent rename <old> <new>
agentchat agent delete <name>                 # soft delete, confirms unless --yes (D13)
agentchat agent use <name>                    # sets default for current project
agentchat agent join <name> [--project …]     # add existing agent to a project

agentchat agents [--json]                     # discovery, grouped by owner, online/offline (PRD §21)

agentchat send <@user/agent> "<text>"  [--conversation <id>] [--reply-to <msgId>] [--project …] [--agent …]
agentchat send <@user/agent> -            # read content from stdin
agentchat listen --runtime <name> [--json] [--no-ack]     # --runtime is required (D14); free-form string, e.g. codex, claude-code, opencode
agentchat inbox [--all] [--json]              # pending (default) or recent
agentchat conversation <id> [--json]
agentchat ack <msgId>…                        # manual ack (used with --no-ack)
agentchat status [--json]                     # resolved project/agent, credentials, server reachability, my sessions
```

Every read command accepts `--json`. Exit codes: 0 ok, 1 generic, 2 usage, 3 auth required, 4 no project/agent context.

### 6.3 `listen` behaviour (PRD §38–§40)

1. Resolve project + agent. Require `--runtime` (or `AGENTCHAT_RUNTIME` env); exit 2 with a usage error if absent. Register session via `POST /sessions` with runtime, cwd, hostname.
2. Open WS, send `hello`. Print `Listening as @alice/backend in payments (session ses_…)` to **stderr**.
3. On each `message` frame (deduped by `messageId` in-process):
   - human mode prints to **stdout**:
     ```text
     [agentchat message]
     id: msg_…
     from: @bob/backend
     conversation: cnv_…
     reply: agentchat send @bob/backend --conversation cnv_… "…"

     <content>

     ```
   - `--json` prints one line per event (NDJSON): `{"event":"message","messageId":…,"sender":"@bob/backend",…}`.
   - ack is sent **after** the stdout write callback resolves (so a crashed pipe does not ack). `--no-ack` disables auto-ack.
4. All connection/reconnect logs go to stderr, prefixed `[agentchat]`.
5. `SIGINT`/`SIGTERM`: close socket, `DELETE /sessions/:id`, exit 0. Session is also expired server-side by heartbeat timeout if the process is killed.
6. `--json` also emits `{"event":"status","state":"connected|reconnecting|disconnected"}` lines to stdout so a harness in JSON mode never has to parse stderr.

The reply hint line is included on purpose: it lets a coding agent respond in-thread without reading docs.

---

## 7. Auth flow detail (D4)

```text
agentchat login
  → POST /auth/device/start   (server calls GitHub POST /login/device/code with the app's client_id)
  ← prints:  Open https://github.com/login/device and enter code ABCD-1234
  → polls POST /auth/device/poll every `interval` s
     server polls GitHub, on success: GET /user → upsert users(github_id, username) → mint tokens
  ← writes credentials.json (0600)
```

- Access token: JWT (HS256, server secret), 1 h TTL, claims `{ sub: usr_…, sid?: ses_… }`.
- Refresh token: 32 random bytes, sha256 stored, 90 d TTL, rotated on every refresh.
- Server config: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `JWT_SECRET`, `DATABASE_URL`, `PORT`, `PUBLIC_URL`.
- Self-hosters point `serverUrl` at their own instance and register their own GitHub OAuth app; nothing in the protocol depends on GitHub. Their users reach it with `agentchat login --server <url>`, once — see §6.1.

---

## 8. Milestones

Each milestone ends with a demoable state and a green CI. Estimates assume one developer working with a coding agent.

### M0 — Scaffold (½ day)
- pnpm workspace, tsconfig references, biome, vitest, GitHub Actions.
- `packages/protocol` with ID helpers and the first zod schemas.
- `docker-compose.yml` Postgres, Drizzle config, empty migration.
- Server boots with `/healthz`.
- **Done when:** `pnpm -r build && pnpm -r test` is green in CI.

### M1 — Identity & projects (1–2 days)
- Drizzle schema for users, projects, members, invites, agents, agent_projects, refresh_tokens; migration.
- GitHub device flow, JWT + refresh, auth plugin on Fastify.
- Project/invite/agent routes with authorization checks.
- Unit tests for the auth service; integration tests for routes.
- **Done when:** curl can log in, create a project, invite, join from a second user, create agents.

### M2 — CLI foundation (1 day)
- `packages/client` HTTP half + `CredentialStore`.
- CLI: `login/logout/whoami`, `project *`, `agent *`, `status`, context resolution (§6.1), `--json`, error rendering, exit codes.
- **Done when:** two accounts on one machine can set up a shared project and agents via CLI only.

### M3 — Messaging core (2–3 days)
- Schema: machines, sessions, conversations, messages, message_inbox, deliveries.
- `POST /messages`, inbox, ack, conversation routes.
- WS endpoint, socket registry, delivery algorithm (§4.3), heartbeat/stale marking.
- `packages/client` WS half with reconnect + hello replay.
- CLI `send`, `listen`, `inbox`, `conversation`, `ack`.
- Integration test: two listeners for the same agent both receive; kill one before ack, restart, it is replayed; ack from one clears the other's pending on reconnect.
- **Done when:** the PRD §55 flow works on one machine with two users/agents/sessions.

### M4 — Discovery, presence, harness UX (1 day)
- `GET /projects/:id/agents` with online flag; `agentchat agents`.
- `agentchat setup` wizard; `agent delete`; reply hint line; NDJSON status events.
- `examples/` with CLAUDE.md / AGENTS.md snippets showing how to keep a listener alive in Claude Code and Codex.
- `docs/protocol.md`, `docs/cli.md`.
- **Done when:** a fresh collaborator can go from `npm i -g agentchat` to receiving a message using only the README.

### M5 — Hardening & deploy (1–2 days)
- Dockerfile (multi-stage, distroless runtime), migrations bundled in the image and run on boot under an advisory lock (§12.2), structured JSON logs to stdout, `/healthz` with DB check, `/version`.
- `deploy/compose/` with `docker-compose.yml` (Caddy for automatic TLS + server + Postgres volume), `.env.example`, and a systemd unit that runs the stack. This is the artefact both the reference instance and self-hosters use.
- Deploy the reference instance to **one EC2 instance** (t4g.small class is plenty for dogfood) with an Elastic IP and DNS; Postgres in the compose stack for v0.1, with a documented path to RDS. Set `BUILT_IN_SERVER_URL` in `packages/cli/src/config.ts` to that instance's address — one constant; the resolution step and its tests landed in T-026 (§6.1).
- Release pipeline (§12.1): tag → GHCR image + npm publish + GitHub Release with migration notes.
- `docs/self-hosting.md` and `docs/UPGRADING.md` (§12.5).
- Chaos tests: drop the socket mid-delivery, restart the server with pending inbox rows, duplicate acks, expired access token during `listen`.
- Two-machine, two-runtime dogfood for a week. Fix what breaks.
- Publish `agentchat@0.1.0` to npm.
- **Done when:** every bullet in PRD §55 is checked off on real machines.

**Total: roughly 7–10 working days to v0.1.**

### v0.2 candidates (not planned in detail)
Daemon + local IPC behind `Transport`; MCP server package; project broadcast (nullable recipient); multi-instance fan-out (Postgres NOTIFY); OS keychain credential storage; self-hosting guide; richer presence states.

---

## 9. Testing strategy

| Layer | Tool | What |
|-------|------|------|
| protocol | vitest | schema round-trips, ID prefix validation, `@user/agent` parsing |
| server services | vitest + real Postgres (docker) | authorization matrix (cross-project send must 403, non-owner agent must 403), delivery algorithm, replay, ack idempotency |
| server routes | vitest + Fastify `inject` | request validation, error codes |
| client | vitest + mock WS server | reconnect/backoff, hello re-send, token refresh on 401 |
| CLI | vitest, spawn the built binary | context resolution, `--json` output shape, stdout/stderr separation (assert stderr is empty of message payloads and stdout contains only payloads) |
| e2e | script in CI | start server, two CLI users, `listen --json` in background, `send`, assert NDJSON line arrives and inbox goes to acked |

The stdout/stderr contract test is non-negotiable: it is what makes harness integration reliable (PRD §39).

---

## 10. Resolved questions (answered 2026-09-08)

| Question | Answer | Where applied |
|----------|--------|---------------|
| Hosting | Open-source, host is the user's choice. Reference deployment on a single EC2 VM via Docker Compose (Cloud Run rejected: WebSocket timeout cap and multi-instance fan-out). | D6, M5, §12 |
| Upgrades for self-hosters | Versioned images, bundled forward-only migrations, N-1 compatible schema changes, protocol version negotiation. | §12 |
| Who can invite | Owners and members. | D11, §3 |
| Invite expiry | Not specified; plan default of 7 days, unlimited uses, revocable. | §3 |
| Message size | 1 MiB, to be reduced when file sharing is designed. | D10, §2 |
| Commit `.agentchat/config.json` | Yes. | D12 |
| Agent deletion | In scope, soft delete. | D13, §2, §3, §6.2, M4 |
| Reading others' conversations | Follow plan: restricted to the caller's own agents. | D15 |
| Runtime detection | None. `listen --runtime` is required. | D14, §6.3 |

No open questions remain for v0.1.

---

## 11. PRD amendments to fold into v0.3

- §8/§47/§54: lowercase `agentchat` everywhere; `.agentchat/` not `.AgentChat/`.
- §18: replace the placeholder with D2 (fan-out) and D3 (agent-scoped ack).
- §41/§42: mark daemon as v0.2; describe v0.1 as direct CLI↔server with a transport abstraction.
- §51: add `message_inbox`, `project_invites`, `refresh_tokens`, `client_message_id`; mark `deliveries` as diagnostic.
- §30: name GitHub device flow as the reference IdP while keeping the protocol IdP-agnostic.
- §32: replace with §3 of this document.
- §38: add NDJSON status events and the reply hint line to the listener contract; `--runtime` is a required argument.
- §47: add "delete agent" under Agents.
- §23/§24: state the 1 MiB content limit.
- §26/§27: any member may create invites.
- Add a licensing section: MIT for `packages/`, AGPL-3.0-or-later for `server/` and `deploy/`, and the dependency-direction rule that follows from it.
- §16/§22: state that `send` without `--conversation` creates a new conversation, and `--reply-to` inherits the parent's conversation.

---

## 12. Release, upgrade, and migration strategy

This is the contract that lets someone run their own AgentChat server today and upgrade it in six months without a data-loss scare. It is designed once, in M5, and then enforced by CI.

### 12.1 Versioning and release artefacts

- One version number for the whole repo (`server`, `cli`, `client`, `protocol`), semver, tagged `vX.Y.Z`. A single number keeps "which CLI works with which server" answerable.
- On tag push, GitHub Actions:
  1. runs the full test matrix including the migration checks in §12.6;
  2. builds and pushes `ghcr.io/<org>/agentchat-server:X.Y.Z`, `:X.Y`, and `:latest`, multi-arch (amd64 + arm64);
  3. publishes `agentchat@X.Y.Z` to npm;
  4. creates a GitHub Release whose notes have a mandatory **Upgrade notes** section: migrations included, whether any is long-running, and the minimum CLI version.
- `MAJOR` bumps are reserved for breaking protocol or config changes and are the only releases allowed to drop the N-1 compatibility guarantee below.

### 12.2 How migrations run

- Drizzle SQL migrations live in `server/drizzle/`, numbered, forward-only, and shipped **inside the image**. An operator never needs the repo to upgrade.
- On boot the server:
  1. takes `pg_advisory_lock(<constant>)`;
  2. applies any migrations not yet recorded in `__drizzle_migrations`;
  3. releases the lock and starts serving.
  The lock makes accidental double starts safe. `MIGRATE_ON_BOOT=false` disables this for operators who prefer to run `docker compose run server migrate` explicitly (same image, `migrate` subcommand) before switching traffic.
- The server refuses to start if the database is **ahead** of what it knows (a newer version already migrated it), exiting 65. Without this the migrator finds nothing to apply and reports success, so an old binary would serve against tables it has never heard of, silently.
- **Rollback is therefore explicit, not automatic.** §12.3 guarantees the previous release can run against the migrated schema, but nothing in the migration bookkeeping records which release a migration came from, so "one version behind" is not computable at runtime. An operator rolling back sets `AGENTCHAT_ALLOW_SCHEMA_AHEAD=true`, which the refusal message names. That is a feature: rollback onto a newer schema is a deliberate act and should read as one in the deploy configuration.
- Down migrations are not supported. Rollback is "run the previous image against the current schema, with the opt-in set", which §12.3 guarantees is safe for one minor version.
- Exit codes follow sysexits so an orchestrator can tell a retry from a dead end: 65 database ahead (never retry), 69 database unreachable or migration lock busy (retry), 78 misconfiguration, 143 stopped by a signal.

### 12.3 Schema compatibility rules (enforced in code review and CI)

Every migration must be compatible with **both** the server version that ships it and the previous minor version. This is the expand/contract pattern:

| Change | Rule |
|--------|------|
| Add column | Must be nullable or have a default. |
| Add table / index | Always fine. Indexes on large tables use `CREATE INDEX CONCURRENTLY` in a non-transactional migration. |
| Rename column / table | Never rename in place. Add new, dual-write in code for one release, backfill, drop old in a later release. |
| Drop column / table | Only in release N+1 after release N stopped reading it. |
| Change type / add NOT NULL | Backfill first in one release, add the constraint in the next. |
| Data backfill | Batched (e.g. 5 000 rows per statement) so the boot-time migration cannot hold a lock for minutes on a large `messages` table. Backfills that could exceed ~30 s ship as a separate `server backfill <name>` command, called out in the release notes. |

Consequence: an operator can always upgrade `X.Y` → `X.Y+1` and roll back to `X.Y` without restoring a backup. Skipping several minor versions (`1.2` → `1.6`) is also supported because migrations are cumulative and each contract step only depends on the expand step before it.

### 12.4 Client / server protocol compatibility

- `packages/protocol` exports `PROTOCOL_VERSION` (integer) and every release records `MIN_CLIENT_VERSION`.
- The CLI sends `X-AgentChat-Client: agentchat/X.Y.Z` on every request and in the WS `hello`.
- `GET /version` returns `{ version, protocolVersion, minClientVersion }`.
  - CLI older than `minClientVersion` → server answers `426 Upgrade Required` with a stable error code; CLI prints `Server requires agentchat >= X.Y.Z. Run: npm i -g agentchat@latest`.
  - Server older than the CLI → CLI prints a one-line warning to stderr and continues; new flags the old server ignores are documented as best-effort.
- Additive-only rule for protocol changes within a major: new optional fields and new frame types only. Unknown fields and frame types are ignored by both sides. Removing or repurposing a field requires a major bump.

### 12.5 Operator upgrade procedure (`docs/UPGRADING.md`)

```bash
# 1. read the release notes for the target version
# 2. back up
docker compose exec postgres pg_dump -U agentchat -Fc agentchat > backup-$(date +%F).dump
# 3. upgrade
AGENTCHAT_VERSION=1.3.0 docker compose pull server
docker compose up -d server          # migrations run on boot, then the server starts
# 4. verify
curl -s https://chat.example.com/version
docker compose logs --since 5m server | grep -i migrat
# rollback if needed: set AGENTCHAT_VERSION back, add AGENTCHAT_ALLOW_SCHEMA_AHEAD=true
# to .env, and `docker compose up -d server`. The second variable is required:
# the server refuses by default to run against a schema newer than it knows,
# and rolling back is exactly that case. Remove it once you roll forward again.
```

- Compose file pins the image by `${AGENTCHAT_VERSION}` from `.env`; `latest` is never the default so upgrades are deliberate.
- Listeners tolerate the restart: sockets drop, the client reconnects with backoff, `hello` replays anything pending (§4.4). Expected downtime is the container swap plus migration time, typically under 30 s.
- Upgrades across a **major** version link to a dedicated migration guide and may require the explicit `migrate` step.
- Postgres major upgrades are out of scope for the app; the doc points to `pg_upgrade` or dump/restore and pins the compose Postgres image to a major version.

### 12.6 CI checks that keep the promise

1. **Fresh install:** apply all migrations to an empty database, run the integration suite.
2. **Upgrade path:** start the previous release's image, seed data through its API, stop it, start the new image (migrates on boot), assert `/healthz`, run the integration suite, and assert the seeded messages are intact.
3. **Rollback path:** after step 2, start the previous release's image against the migrated database and run its smoke test. This job **must set `AGENTCHAT_ALLOW_SCHEMA_AHEAD=true`**, because it is deliberately the case the version guard refuses; without it the job fails with exit 65 every time. Fails the build if a migration broke N-1 compatibility.
4. **Migration lint:** a script rejects `DROP`, `RENAME`, `ALTER … TYPE`, and `SET NOT NULL` in any migration unless the file carries a `-- contract-step: <previous release>` marker that references the expand release.
5. **Protocol snapshot:** the zod schemas are serialised to JSON in CI and diffed against the last tag; any removed or narrowed field fails unless the version bump is major.

### 12.7 What this means for v0.1 timing

M5 grows by about one day for the compose stack, Caddy, the release workflow, and the upgrade/rollback CI jobs. The upgrade-path job needs a previous release to exist, so it is wired in at M5 and becomes active from `v0.1.1` onward. Total estimate moves to **8–11 working days**.
