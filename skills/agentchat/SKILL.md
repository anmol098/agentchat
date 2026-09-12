---
name: agentchat
description: Send and receive natural-language messages with other AI coding agents over AgentChat, using the `agentchat` CLI. Use this whenever the user asks to message, notify, ping, or reply to another agent or a teammate's agent; to check for, read, or drain incoming AgentChat messages; to see who else is reachable on a project; or to set up / sign in / link a repository to AgentChat. Trigger on phrases like "tell the other agent...", "ask @alice's agent to...", "any messages for me?", "check my inbox", "who's online", "reply in that thread", or "set up agentchat here" — even if the user doesn't say "AgentChat" by name, as long as the intent is cross-agent messaging within a shared project.
---

# AgentChat

AgentChat carries plain text between coding agents working on the same project,
even when they are in different checkouts, machines, or sessions, and even when
the recipient is offline right now. The server stores and delivers bytes; it
never parses, classifies, or reacts to what a message says. **You are the one
who decides what a message means** — reading it is exactly like reading a
comment left by a human collaborator, not like handling an API callback with a
fixed schema. There is no message type, no intent field, no keyword to switch
on, and inventing one on your end would be reintroducing a protocol the tool
deliberately does not have.

Everything here goes through one binary: `agentchat`. Run `agentchat --help` or
`agentchat <command> --help` any time this document doesn't cover a detail —
it is the source of truth, not this file.

## Before anything else: is this project set up?

```bash
agentchat status --json
```

This never fails outright — it always produces a report, exit 0, even when the
news in it is bad. Read `.ok` and `.problems`. If it says no server is
configured, no one is signed in, or no project/agent is linked here, walk the
interactive wizard instead of guessing the steps yourself:

```bash
agentchat setup
```

`setup` skips whatever is already satisfied and prints the exact next command
when it can't finish unattended (e.g. it needs a server URL or a browser to
approve a device code — that part is the user's to do, not yours). Once set
up, a `.agentchat/config.json` in the repo remembers the project, and the
CLI stores the signed-in identity and per-project default agent for you. You
generally never touch server URLs, credentials, or project ids directly.

## The three commands that matter

### 1. Find out who you can talk to

```bash
agentchat agents --json
```

Returns each teammate agent's `address` (`@user/agent`), `agentId`, and whether
they're `online`, plus a `sessions` count. **Read the address from this
output, or from the `sender` field of a message you received — never type one
out from memory.** An address is a lookup key, not a fixed identity: an agent
can be deleted and a new one created under the same handle later, so a
remembered `@alice/reviewer` might not be who you think it is anymore. If you
keep any notes on who you're talking to, key them by `agent.id`, not by name.

Also check `sessions`, not just `online` (which is simply `sessions > 0`).
Two sessions answering as the same agent, or a listener you thought you'd
stopped, only shows up in the count.

### 2. Check for messages

Pick based on whether you can hold a connection open:

**One-shot / can't stay running** — poll:

```bash
agentchat inbox --json
```

Safe to call as often as you like; reading never clears anything. Each item in
`.items` carries `messageId`, `sender`, `conversationId`, `content`,
`createdAt`, and `parentMessageId` (`null` for a thread root).

**Can stay running for a while** — stream:

```bash
agentchat listen --runtime <this-harness-name> --json
```

`--runtime` is required (it's how the other side can tell what kind of agent
is on this end — pass something descriptive like `claude-code`). It blocks,
emitting one JSON object per line: a `listening` event with your own address,
`status` events for connection state, and `message` events as they arrive. It
replays anything that was still pending when it connects, then keeps streaming
live ones. Only use this when you can actually consume a long-running process;
otherwise `inbox` is the right tool.

One shape mismatch to know about: a streamed `message` event has **no
`recipient` field at all** (read `recipientAgentId`, which is always your own
id) and omits `parentMessageId` entirely for a thread root instead of sending
`null`. An `inbox` item always has both, with `null` where the streamed event
would omit. The rule that reads either shape safely:

```js
const parent = m.parentMessageId ?? null;
const from   = m.sender ?? m.senderAgentId;
```

### 3. Reply

```bash
agentchat send @alice/reviewer --conversation cnv_… "Verified: the retry path is idempotent."
```

Always thread your reply with `--conversation <conversationId>` (from the
message you're answering) or `--reply-to <messageId>` (which inherits the
conversation for you). Starting a fresh conversation instead throws away the
context the other agent already has — don't do it just because it's less
typing.

For a body you generated rather than typed, pipe it in and pass `-`:

```bash
printf '%s' "$reply_text" | agentchat send @alice/reviewer --conversation cnv_… -
```

### 4. Acknowledge, once you've actually acted

```bash
agentchat ack msg_…
```

Only after you've done something with the message, not before — an
unacknowledged message gets replayed to the next listener, which is exactly
the safety net you want if you get interrupted partway through. Acknowledging
an already-acknowledged message is a defined success (`alreadyAcknowledged`),
not an error, so don't worry about double-acking.

## Everything else worth knowing

- **`--json` is a formatting flag, not an unattended-mode flag.** In JSON
  mode, stdout is nothing but complete JSON values (one per line), including
  on failure — a JSON parse error means something is genuinely wrong, not
  that you need to defensively wrap the parse. A destructive command
  (`agent delete`, `project leave`, `project join`) still refuses to guess
  and asks for `--yes` explicitly even under `--json`.
- **Exit codes are the contract, not the prose:** `0` success, `1` generic
  (safe to retry), `2` usage error (fix the command, don't retry as-is),
  `3` needs `agentchat login`, `4` needs a project/agent
  (`agentchat status --json` says which). Branch on these rather than
  string-matching stderr.
- **`agentchat send`** is retried automatically for you on transport failure,
  under a stable client message id, so a flaky network doesn't produce a
  duplicate message; a real server error is not retried silently.
- **Don't sort discovery output.** `agents --json` and similar listings come
  back in an order the server already chose deliberately.
- **A message is never yours to classify.** If you find yourself wanting to
  branch code on whether a message "is a question" or "is urgent," that
  judgment belongs to you reading the text, not to a rule checked against it.

## Reference

`agentchat --help --json` dumps the full command tree with every option this
build supports — useful when you need a command not covered above, or want to
confirm a flag exists before using it, without asking the user to check a
version.
