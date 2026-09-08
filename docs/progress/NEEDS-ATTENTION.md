# Needs your attention

Decisions, risks, and observations that came out of the build and are **not** tracked as tasks, either because they are yours to make or because they are about the process rather than the code.

Maintained by the orchestrator as work proceeds. Tasks live on the [board](./BOARD.md); this file is what the board cannot hold.

Nothing here blocks current work.

---

## 1. Decisions only you can make

### 1.1 Branch protection is not set

The repository has no branch protection at all, while several workflow comments are written as though it exists. Nothing depends on it, and every check has stable names, so this is a settings change whenever you want it.

Require `ci`, `licences` and `protocol`. The first fans in from the test jobs, so it survives new jobs being added without editing the rule.

### 1.2 The protocol version has been raised twice for breaks with no consequence

It is at 3. Both increments narrowed a validation pattern, which the compatibility guard correctly calls breaking, and both happened while nothing had shipped and every consumer lives in this repository.

Two agents independently argued the same thing: breaking by the letter, not by consequence. The guard is right to be conservative, because a guard that decided for itself whether a project had "really shipped" would contain an argument, and that argument gets won by whoever is in a hurry.

**Before the first release**, decide whether to reset it to 1. It is free until a release exists and impossible afterwards. There is also a suggestion on the table for a pre-release mode that still demands a written reason but does not mint uninformative version numbers.

### 1.3 Some real GitHub accounts cannot sign in

The username grammar was narrowed to match GitHub's actual registration rule. That rule governs registration, not accounts that already exist, and two live examples were found: an account ending in a hyphen and an organisation with a double hyphen.

Those users are now cleanly rejected rather than failing on a database constraint, which is an improvement. They still cannot use AgentChat. Widening to admit them needs both the protocol and the database column changed together, and it is a product decision rather than a defect.

### 1.4 There is no default server address, deliberately

A fresh install has nowhere to point until someone runs `agentchat login --server <url>` once, which is then remembered.

This was chosen over shipping a default, because a default decides which host receives a device authorization and ends up holding a user's tokens, and no reference instance exists yet. A constant is in place for milestone 5 to fill in; it is never written into user configuration, so setting it later reaches everyone rather than only people who never logged in.

If you want a hosted default, that is one constant plus a deployed instance.

### 1.5 Invite codes are stored in the clear

They are seven-day, revocable, single-project grants rather than long-lived credentials, and the column is documented as the human-typed code with a constraint requiring it to be uppercase. A digest would satisfy that constraint's letter while inverting the column's meaning.

The case a digest would defend is real but narrow: a stale read-only database dump replayed within seven days. If `project_invites` is ever migrated for another reason, that is the moment to reconsider.

---

## 2. Risks in how this is being built

### 2.1 Worktree isolation is weaker than it looks

Files belonging to one task appeared inside another task's worktree while both were running. The directories are genuinely separate, so something wrote across them.

No damage occurred: the files arrived untracked, the receiving agent left them alone, and its branch contained only its own work. But an agent that committed blindly would have shipped another task's half-finished code, and a write that overwrote rather than added would have destroyed work.

Agents are now told to verify they are in their own worktree and never to stage files they did not create.

### 2.2 An interrupted agent loses everything unless it commits as it goes

One task's work was destroyed outright: the agent stalled without committing and its worktree was removed. Nothing was staged, so git had nothing to recover.

The same interruption hit another task that had been told to commit in steps, and its work survived intact on the branch.

Every agent is now told to commit in logical steps. This is the single highest-value instruction in the whole prompt template.

### 2.3 A failing test was right and the schema was wrong

An integration test failed once while I was verifying main, asserting that renaming an agent bumps its timestamp. It would have been easy to re-run and forget.

The cause is real: the timestamp column takes its insert value from the database's clock and its update value from the application's, and those disagreed by 65 milliseconds in a direction that changes. The value can move backwards. Tracked as T-035.

Worth noting as a pattern: on this project, tests that fail intermittently have been genuine findings twice and environmental noise twice, and the only way to tell has been to look each time.

### 2.4 Tests fail on a loaded machine and pass in continuous integration

Two tests time out at five seconds when several agents are running builds concurrently. They pass alone and on an idle runner, so continuous integration never sees it.

A timeout reports as a red test with no explanation, so the reader's first assumption is that the code broke. Tracked as T-029.

### 2.5 The path-ownership rule has a blind spot at the seams

Three times now, several concurrent tasks each needed one line in a file none of them owned, each correctly declined to cross the boundary, and finished work sat unreachable. Authentication wiring, the package barrel, and route registration.

The fix has been to create the seam task **before** the tasks that need it, which is now done for route registration. Worth remembering when decomposing the remaining milestones: the joins need an owner as much as the parts do.

### 2.6 The board cannot see every collision

Two tasks owning different files can still collide on a generated artefact neither declares, such as the protocol snapshot. One such pair was held back manually.

The path system only catches what tasks declare. Generated files need either an owner or a rule.

---

### 1.6 Whether the client and protocol packages get published

The CLI cannot currently be installed by anyone, and fixing it forces a decision. It depends on two workspace packages, and packing rewrites those into concrete versions that are not on any registry, so the tarball would look fine locally and fail for every user.

Two ways out. Publish the client and protocol packages alongside it, which makes them a public surface with a compatibility promise attached. Or bundle them into the CLI's tarball, which keeps the surface small and makes the protocol opaque to anyone who wanted to embed it.

The licences point one way: `packages/` is permissive precisely so third parties can build on the protocol. Bundling it away has a cost beyond convenience. Tracked as T-037.

---

## 3. Known gaps not yet worth a task

- **Parser documentation overstates the code in three more places.** A short flag is handled in one scan but never declared, so using it suppresses output and then dies with a usage error. Reported during T-027 and left as out of scope.
- **The invite preview discloses who created the project**, slightly beyond "name and inviter". Fixed by the protocol contract rather than the route, so it needs a schema change.
- **A client docstring says the wrong error code** for an agent the caller does not own. The behaviour is right; the comment is stale.
- **Two defensive race branches in the invite service are uncovered.** Named in that task's pull request.
- **The device-flow store is per-process and in memory.** With more than one server instance, an authorization started on one and polled on another simply fails. Not a problem while the deployment pins to one instance, which it does for a separate reason, but the two constraints should lift together. Noted in T-031.
- **An exit-code test spawns the binary seventeen times inside one test body.** Folding those assertions into the loops directly above it would delete seventeen process spawns and name the offending code on failure. Reported by T-029 and left to the file's owner.

---

## 4. Corrections made to my own specifications

Recorded because they are the specification being wrong, not the code.

- **An acceptance criterion asked for distinct error codes** for an expired invite and a revoked one. Telling a caller their code was once real confirms a guess hit something. The criterion was wrong and is corrected.
- **The plan contradicted itself on rollback**, requiring a server to refuse a database newer than itself while three other sections described rollback as exactly that. Resolved as refuse-by-default with an explicit opt-in, and the plan amended.
- **A handoff note was cited in the wrong place.** An agent was told to read a task log that did not contain it. It found the note anyway and said so.
- **A migration job was made to require credentials it never uses**, as a side effect of wiring authentication. Tracked as T-022.
