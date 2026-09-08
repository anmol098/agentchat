# Working in this repository

This project is built by multiple agents working in parallel worktrees. **Read [`docs/SUBAGENT-PROTOCOL.md`](docs/SUBAGENT-PROTOCOL.md) before doing anything else.** It is normative, not advisory.

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
| [Subagent Protocol](docs/SUBAGENT-PROTOCOL.md) | How to claim work, report, and what "done" means |
| [Progress Board](docs/progress/BOARD.md) | What is being worked on right now |
| [Implementation Plan](docs/IMPLEMENTATION-PLAN.md) | Architecture, data model, protocol, milestones |
| [PRD](docs/PRDv0.2.md) | Product philosophy and invariants |

## Rules that override convenience

- **The server never interprets message content.** No semantic event types, no content inspection, no server-side reasoning. This is the product, not an implementation detail. See PRD §3.7 and invariants 5 and 6.
- **`agentchat listen` writes only message payloads to stdout.** Every operational log goes to stderr. Breaking this breaks every harness integration.
- **Shared contracts are never changed unilaterally.** Schema, wire protocol, and public CLI surface are decided in the implementation plan first, then implemented. If the plan is silent or wrong, escalate; do not guess.
- **`docs/progress/BOARD.md` is generated.** Edit task files and run `node scripts/board.mjs render`.
