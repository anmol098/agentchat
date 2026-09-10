# Working in this repository

This project is built by multiple agents working in parallel worktrees. **Read [`docs/subagent-protocol.md`](docs/subagent-protocol.md) before doing anything else.** It is normative, not advisory.

## The short version

1. **Never start work without a claimed task.** Find one, claim it, push the claim, then work.
   ```bash
   node scripts/board.mjs list --status todo --ready
   node scripts/board.mjs claim T-XXX --owner <your-agent-name>
   ```
2. **Work in a worktree on a task branch**, never directly on `main`.
3. **Touch only the paths your task declares.** Needing a file outside that list is a signal to stop and escalate, not to widen scope.
4. **Report progress to the board**, committed straight to `main`:
   ```bash
   node scripts/board.mjs log T-XXX "<what actually happened>"
   ```
5. **Pass the gates before opening a pull request:**
   ```bash
   pnpm format:check && pnpm lint && pnpm typecheck && pnpm test
   ```

## Documents, in reading order

| Document | What it settles |
|----------|-----------------|
| [Subagent Protocol](docs/subagent-protocol.md) | How to claim work, report, and what "done" means |
| [Progress Board](docs/progress/board.md) | What is being worked on right now |
| [Implementation Plan](docs/implementation-plan.md) | Architecture, data model, protocol, milestones |
| [PRD](docs/prd.md) | Product philosophy and invariants |

## Rules that override convenience

- **The server never interprets message content.** No semantic event types, no content inspection, no server-side reasoning. This is the product, not an implementation detail. See PRD section 3.7 and invariants 5 and 6.
- **`agentchat listen` writes only message payloads to stdout.** Every operational log goes to stderr. Breaking this breaks every harness integration.
- **Shared contracts are never changed unilaterally.** Schema, wire protocol, and public CLI surface are decided in the implementation plan first, then implemented. If the plan is silent or wrong, escalate; do not guess.
- **`docs/progress/board.md` is generated.** Edit task files and run `node scripts/board.mjs render`.
- **Nothing under `packages/` may import from `server/`.** `packages/` is MIT and `server/` is AGPL. MIT code can be absorbed into an AGPL work, never the reverse, so this dependency direction is a licensing boundary rather than a style preference. Crossing it silently relicenses the permissive half of the project. See [LICENSE](LICENSE).
- **New dependencies under `packages/` must be permissively licensed** (MIT, ISC, BSD, or Apache-2.0). Copyleft dependencies belong under `server/` only.
