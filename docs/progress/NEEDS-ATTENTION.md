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

**A later usage limit killed five agents at once, and the rule paid for itself.** All five had been told to commit in steps. Between them they left seventeen commits and two uncommitted files, both small. Every task was resumed from its own work rather than restarted, and one of the resuming agents found its predecessor had got further than the handover note said.

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

### 2.6 Agents contend over the shared development database

Several agents run their suites against one Postgres container. That has now caused three distinct problems: cluster-wide lock assertions failing, one agent recreating the container without a published port while another was using it, and a deployment task briefly adopting the development volume because both stacks shared a project name.

None caused lasting damage, and each was noticed and reported rather than worked around. But the pattern is that a shared mutable resource under concurrent agents produces failures that look like defects in whatever happened to be running.

The fix agents have converged on themselves is a throwaway container per run, which one task did rather than fight over the shared one.

### 2.7 The board cannot see every collision

Two tasks owning different files can still collide on a generated artefact neither declares, such as the protocol snapshot. One such pair was held back manually.

The path system only catches what tasks declare. Generated files need either an owner or a rule.

---

### 1.6 Whether the client and protocol packages get published

The CLI cannot currently be installed by anyone, and fixing it forces a decision. It depends on two workspace packages, and packing rewrites those into concrete versions that are not on any registry, so the tarball would look fine locally and fail for every user.

Two ways out. Publish the client and protocol packages alongside it, which makes them a public surface with a compatibility promise attached. Or bundle them into the CLI's tarball, which keeps the surface small and makes the protocol opaque to anyone who wanted to embed it.

The licences point one way: `packages/` is permissive precisely so third parties can build on the protocol. Bundling it away has a cost beyond convenience. Tracked as T-037.

---

### 2.8 Stub servers hid five broken commands

Every command test uses a stub server that answers endpoints the real server never implemented. The commands are correct against a server that does not exist, and all their gates pass.

Three authentication endpoints are missing, and five commands call them. The refresh gap means a listener left running overnight dies when its access token expires and cannot recover without a human. Tracked as T-043.

The lesson is about where the gap lives rather than about stubs being wrong. Unit tests prove the client is correct, integration tests prove the server is correct, and nothing proved they were talking about the same endpoints.

**The end-to-end suite has since run, and it found this unprompted.** On its very first execution, before its author had gone looking, every command in the delivery path failed with `Route GET /me does not exist`. It is now a required gate, so this class of gap cannot reopen silently.

---

### 2.9 A task edited two files it had not declared, and the board could not see it

T-314 declared `server/test/integration` and `tests/e2e`. The first directory
does not exist — integration tests live in `server/tests/*.integration.test.ts`
— and while it was running it also modified `server/src/app.ts` and
`vitest.config.ts`. Neither is in its declared paths.

`server/src/app.ts` is owned by T-041, which was therefore held rather than
started, and the board reported no collision because a path nobody declares
collides with nothing.

This is the same blind spot as the generated-file case, reached from the other
direction: there, two tasks touched a file neither wrote by hand; here, one task
touched a file it simply did not list. `board.mjs check` validates that declared
paths do not overlap. It cannot validate that they are *complete*, because it
never sees a worktree's diff.

The cheap fix is a check that compares a branch's changed files against its
task's declared paths before merge, and fails on anything outside them. It would
have caught this at the first commit rather than at the orchestrator's next
scheduling decision. Whether the friction is worth it is a judgement call for
the maintainer, which is why it is recorded here rather than implemented.

### 2.10 A hand-merged snapshot passes the check and is still wrong

T-039 added a direction map to the protocol snapshot, recording which way each schema travels so that a change can be judged by it. T-028 was open at the time and added three session schemas.

The rebase produced no conflict and `protocol:check` passed. The file was still wrong: the three schemas were in the contract and absent from the direction map. Nothing would have failed. An unclassified root is judged strictly, so the next safe widening of any of those three would have been refused, and the person who hit it would have had no reason to suspect a merge from weeks earlier.

Caught by regenerating the snapshot and diffing it against the merged one. The rule now written down is that a snapshot conflict is always resolved by regeneration, never by hand, and the file is treated as generated rather than owned by any task.

The general shape is worth keeping: a check that passes is not evidence that a generated file is correct, only that the part the check reads is.

---

### 2.11 A gate that had never run cold reported a false failure on somebody else's branch

The upgrade verification job waited for PostgreSQL with a socket-based liveness probe. The official image initialises a cluster by starting a temporary server, running the init scripts against it, and shutting it down before starting the real one — and that temporary server owns the socket while refusing TCP.

So the probe could answer "ready" for a server about to stop. It passed on its own pull request and on my machine, where the image was warm and initialisation had happened on some earlier run, and failed on the first CI job to pull the image cold. It failed on an unrelated branch, where it looked like that change had broken the upgrade promise.

Two things to carry forward. A test that passes locally and fails in CI is usually blamed on CI; here CI was right and the local run was the misleading one, because the local machine had state CI never has. And a gate has not been verified until it has run in the environment it will run in.

---

### 2.12 I merged two pull requests without confirming their checks

My wait loop broke out of its poll when GitHub briefly returned an empty check list, which reads identically to "nothing is pending". It reported zero passes and zero failures and I merged on that.

Both had passed CI before their final rebase, and I ran the full local gates on each and on `main` afterwards, so nothing broken reached `main`. The process failure is still real and is recorded because the next such loop should not repeat it: the loop now requires a non-empty result *and* no pending row before it will stop waiting.

### 2.13 Three correct modules, wired together, break the product's central promise

Worth reading even if nothing else here is. It is the best example so far of a defect that no module's own tests could have found.

Wiring the heartbeat connected three pieces that were each written carefully, each tested, and each right on its own terms:

1. **The heartbeat marks a session `stale` when its socket closes**, cleanly or not. Right: presence must stop claiming a listener that is not connected.
2. **The handshake refuses any session that is not `active`**, closing with `4403`. Right, and documented in the protocol.
3. **The reference client treats `4403` as fatal** and stops retrying, because reviving a session is the caller's decision rather than a retry loop's. Right, and reasoned in a comment.

Connected, they mean the first disconnect ends a listener permanently — the exact failure the product exists to prevent. `agentchat listen` registers a session once and would never register another.

Reproduced against the assembled server, from a fresh session: hello succeeds, the socket closes cleanly, the session goes `stale`, and the reconnect's hello is refused. Confirmed as a regression by running the same fixture on `main`, where the session stays `active`.

Two things to carry forward. First, the failing tests looked exactly like a stale fixture — a session shared across cases that had simply gone bad — and the tempting repair was to give each test its own session, which would have made the suite green and shipped the defect. Second, this is the fifth time on this project that finished, unreachable work has been the problem, and the first time that connecting it revealed the modules disagreed rather than merely that nobody had called them. The seam is where the design gets tested, and there is no test for a seam that does not exist yet.

The proposed resolution is that `hello` revives a `stale` session: `stale` means nothing is connected right now, and a `hello` is the evidence that something is again. Recorded on T-041 with the argument, and that task is held until it is fixed.

### 2.14 A benign retry after logout signs the user out everywhere

Filed as a wording problem — a retried logout answered with a security alarm — and it turned out to be a good deal worse. `rejectUnspendable` calls `revokeAllForUser` *before* it throws, so the alarm is not just a message: retrying a refresh with a logged-out token revokes every other live session that account holds.

A dropped connection, a re-run script, or a user pressing the button twice therefore signs them out on every machine, writes a false `refresh token replayed` warning to the log, and answers the second, innocent client with a second false alarm whose `revokedCount` of 0 contradicts what the error type documents about itself.

Two things worth keeping. The task was filed from a symptom noticed in passing while verifying something else, and the symptom was the least of it — the report understated its own finding, and reading the path rather than trusting the summary is what surfaced the rest. And the agent assigned to it stopped and escalated rather than reaching for the migration it needed, which is why the design was reviewable before any code existed.

The fix is settled and recorded on T-050. The subtle part is that the calm answer must be *byte-identical* to the existing generic rejection rather than a new gentler message: a distinct third answer would tell anybody holding a harvested string that it had once been real, which is a new §3.2 leak. The fix moves the logout case into the indistinguishable class; it must never add to it.

## 3. Known gaps not yet worth a task

- **Parser documentation overstates the code in three more places.** A short flag is handled in one scan but never declared, so using it suppresses output and then dies with a usage error. Reported during T-027 and left as out of scope.
- **The invite preview discloses who created the project**, slightly beyond "name and inviter". Fixed by the protocol contract rather than the route, so it needs a schema change.
- **A client docstring says the wrong error code** for an agent the caller does not own. The behaviour is right; the comment is stale.
- **Two defensive race branches in the invite service are uncovered.** Named in that task's pull request.
- **The device-flow store is per-process and in memory.** With more than one server instance, an authorization started on one and polled on another simply fails. Not a problem while the deployment pins to one instance, which it does for a separate reason, but the two constraints should lift together. Noted in T-031.
- **A measurement I reported was mostly noise.** I recorded 65 ms of clock skew between the container and host. Measured over the wire protocol rather than through a process-spawning shell command, the same containers read 0.1 ms; most of what I measured was `docker exec` starting a process. The defect behind it was still real and still fixed, but the number was wrong, and a test written to that number would have been calibrated to nothing.
- **An exit-code test spawns the binary seventeen times inside one test body.** Folding those assertions into the loops directly above it would delete seventeen process spawns and name the offending code on failure. Reported by T-029 and left to the file's owner.

---

## 4. Corrections made to my own specifications

### 4.x A verification recipe I gave was a false-positive trap

I told an agent to check whether an endpoint exists by probing it anonymously and reading a `401` as "the route exists and wants authentication", a `404` as "it does not exist".

That is wrong on this server, and the agent caught it. Routes here are protected by omission: the authentication guard runs before routing resolves, so an unregistered path and an unauthenticated request produce the identical `401`. Probing anonymously, `/me` (served), `/version` (not served) and a nonsense path all answer `401`.

Reproduced afterwards to be sure. With a signed access token the three separate cleanly: `/me` answers from its own handler, while `/version` and the nonsense path both answer `404` from the catch-all.

The recipe is now: probe with a valid token, and treat only a `404` as absence. Worth keeping because I had used the anonymous form myself earlier in the session and got a right answer by luck — `/me`, `/auth/logout` and `/auth/refresh` happened to exist.


Recorded because they are the specification being wrong, not the code.

- **An acceptance criterion asked for distinct error codes** for an expired invite and a revoked one. Telling a caller their code was once real confirms a guess hit something. The criterion was wrong and is corrected.
- **The plan contradicted itself on rollback**, requiring a server to refuse a database newer than itself while three other sections described rollback as exactly that. Resolved as refuse-by-default with an explicit opt-in, and the plan amended.
- **A handoff note was cited in the wrong place.** An agent was told to read a task log that did not contain it. It found the note anyway and said so.
- **A migration job was made to require credentials it never uses**, as a side effect of wiring authentication. Tracked as T-022.
