# Release readiness for 0.1.0

Every bullet in the product requirements' definition of done (section 55), checked against what this build actually does, with the evidence named. Written by the orchestrator as the verifiable half of T-511.

**Nothing here is a substitute for the dogfood.** Five of the twelve bullets are about two people on two machines over a week, and a test suite cannot establish those however green it is. Those are marked *needs the dogfood* and are the reason T-511 stays open.

---

## The core flow

> Developer A starts Agent A → send → server persists and routes → Developer B's machine → `agentchat listen` → stdout → Agent B.

**Verified.** `tests/e2e/delivery.integration.test.ts` runs the real built server as its own process, real PostgreSQL migrated by the shipped runner, and the real CLI as a process per command, with only github.com stubbed. It sends between two users in one project and asserts the message arrives on the listener's stdout.

The stdout/stderr split that makes this safe for a harness to parse is asserted separately: *writes message payloads to stdout and every operational line to stderr*.

---

## The twelve claims

| Claim | State | Evidence |
|---|---|---|
| Both developers on different machines | **Needs the dogfood** | Nothing here binds two hosts. Every suite runs on one machine over loopback. |
| Both using different coding runtimes | **Needs the dogfood** | The runtime is a string the agent states, never detected, so a suite can pass any value and prove nothing about a real harness. Three worked examples exist under `examples/`. |
| Each can have multiple agents | **Verified** | Agent creation, listing and per-project membership are covered by `server/src/services/agents.integration.test.ts` and the CLI's agent command tests. |
| Each can have multiple sessions | **Verified** | `tests/e2e`: *delivers one message to both of an agent's listeners*, and *the roster to show two sessions for the recipient*. Decision D3 — the inbox is agent-scoped, not session-scoped — is what makes this work, and `tests/chaos`: *clears the debt for every session of the agent* proves it. |
| Multiple projects on one machine | **Verified for resolution, needs the dogfood for feel** | `packages/cli/src/config.test.ts` and `context.test.ts` cover directory-linked project resolution and the `AGENTCHAT_PROJECT` override. Whether it is *pleasant* across several checkouts is a dogfood question. |
| Messages persist while offline | **Verified** | `tests/e2e`: *delivers a message sent while nothing was listening once a listener starts*, with an explicit assertion that the recipient was offline rather than merely slow. |
| Reconnect works | **Verified, and it was broken until today** | `tests/chaos` covers a severed connection, a server killed between commit and delivery, and an access token expiring under a running listener. T-041, T-053 and T-054 each fixed a defect here that no unit test could have found. |
| Message identifiers provide idempotency | **Verified** | Send carries a client message identifier and a repeat returns the original rather than writing a second. `tests/chaos`: *accepts acknowledgements twice and out of order without losing one*. |
| Projects isolate communication | **Verified** | `server/src/services/messages.integration.test.ts` and `projects.integration.test.ts` cover cross-project refusal at the service layer, against real PostgreSQL. |
| Users can discover participating agents | **Verified** | `GET /projects/:id/agents` with presence and session counts, exercised through the CLI's `agents` command and pinned by `docs/protocol.md`'s own test. |
| No domain-specific event schema is required | **Verified by construction** | The server never inspects content. The only shape on the wire is an envelope; there are no event types to register. |
| No AI watcher service is required | **Verified by construction** | There is no such component. Delivery is a decorator over the message service, and nothing reads a message to decide what to do with it. |

---

## What the gates say

Run on this commit, against real PostgreSQL 18:

| Gate | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint`, `pnpm format:check` | clean |
| `pnpm test` | 2091 passing |
| `pnpm test:integration` | 449 passing, including the end-to-end and chaos suites |
| `pnpm protocol:check` | wire contract unchanged, 69 self-test cases |
| `node scripts/check-licenses.mjs` | clean; nothing under `packages/` imports from `server/` |
| `node scripts/lint-migrations.mjs check` | clean |
| `./scripts/upgrade-test.sh all` | upgrade, rollback, skipped versions and self-test all pass |

Both Node 22.23.2 and 24.20.0, because a defect that appeared only on 22 cost half a day and the matrix is the only reason it was seen.

---

## What blocks the release, and who can unblock it

**Only you can do these. They are not work I have left undone.**

1. **The dogfood itself.** Two people, two machines, two harnesses, a week. Five of the twelve claims above cannot be established any other way, and the requirements say the checklist must be *observed, not assumed*.
2. **Whether `@stackgrid/client` and `@stackgrid/protocol` get published.** The CLI depends on both, and packing rewrites those into versions that exist on no registry — so the tarball works locally and fails for every user. Either publish all three, or bundle the two into the CLI. The licences point one way: `packages/` is permissive precisely so third parties can build on the protocol, and bundling it away has a cost beyond convenience. Recorded as section 1.6 of the attention file.
3. **Branch protection.** Not set. Every gate in this repository is advisory until it is, and this session merged pull requests on the strength of local runs more than once.
4. **Whether to reset `PROTOCOL_VERSION`.** It stands at 3 after two breaks that had no consumers. Resetting it before the first tag is free; afterwards it is a lie in the compatibility record.

---

## What I would not ship without watching first

Not blockers, but the places I would look hardest during the dogfood, because each is where this build has already been wrong once:

- **A listener left running overnight.** The token refresh path has produced two silent deaths, both found by the chaos suite rather than by reasoning. It is fixed and tested; it is still the thing most likely to fail quietly in a way a user reports as "it just stopped".
- **A large backlog after a long absence.** Replay now waits for the socket to drain, so any legal backlog reaches `ready`. That fix is a day old.
- **Anything that reads `--help` rather than the reference.** One wrong sentence about message shapes reached four places including the shipped binary, and was found by writing a document rather than by a test.

## Log

- Written at 106 of 107 tasks done, with every gate green on `main`.
