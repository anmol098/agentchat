#!/usr/bin/env bash
#
# agentchat-turn.sh — one command for a Codex session to run at the top of a
# turn: make sure the listener is up, then print whatever arrived.
#
# Codex has no hook system to start a listener for you, so the agent starts it
# itself. That turns out to be an advantage rather than a workaround: this file
# is one command with no harness API in it at all, so the same file works from
# Codex, from a Makefile target, from a git hook, or from a person typing it.
#
#     ./agentchat-turn.sh
#
# It is idempotent. Running it when the listener is already up and nothing has
# arrived prints nothing and changes nothing, which is what makes it safe to put
# in AGENTS.md as "run this first".
#
# ---------------------------------------------------------------------------
# What it prints
# ---------------------------------------------------------------------------
#
# One block per message, with the identifiers needed to answer:
#
#     ─── agentchat message ───
#     from:         @alice/reviewer
#     message:      msg_…
#     conversation: cnv_…
#     reply:        agentchat send @alice/reviewer --conversation cnv_… -
#     ack:          agentchat ack msg_…
#
#     Can you verify the idempotency behaviour?
#
# It does not say what the message is asking for, and it never will. AgentChat
# carries natural-language text between agents; the server does not read it and
# neither does this script. Deciding what "can you verify the idempotency
# behaviour?" means — a request, a question, something to ignore — is the whole
# of the receiving agent's job, and a script that pre-classified it would be
# taking that decision away.
#
# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
#
#     mkdir -p scripts
#     cp examples/agentchat-listener.sh scripts/
#     cp examples/codex/agentchat-turn.sh scripts/
#     chmod +x scripts/agentchat-listener.sh scripts/agentchat-turn.sh
#     cat examples/codex/AGENTS.agentchat.md >> AGENTS.md
#
# SPDX-License-Identifier: MIT

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LISTENER="${AGENTCHAT_LISTENER:-$HERE/agentchat-listener.sh}"
RUNTIME="${AGENTCHAT_RUNTIME:-codex}"

[ -x "$LISTENER" ] || {
  printf 'agentchat-turn.sh: %s is missing or not executable.\n' "$LISTENER" >&2
  exit 2
}

# Starting an already-started listener is a no-op that says so on stderr, so
# this line is the whole of "keep it alive": run it every turn and the listener
# exists from the first turn onwards. The supervisor inside it handles restarts.
#
# A failure here is reported rather than swallowed, because the failure that
# matters is the quiet one: a turn script that carries on after the listener
# refused to start leaves an agent believing it is reachable when nothing is
# listening. `start` prints the reason — usually no server configured, no
# credentials, or a directory not linked to a project.
if ! "$LISTENER" start --runtime "$RUNTIME"; then
  printf 'agentchat-turn.sh: the listener is not running, so nobody can reach you.\n' >&2
  exit 1
fi

# Everything that arrived since the last turn, one block per message. `drain`
# writes nothing but message envelopes to stdout, so the rendering below is the
# only thing between the wire and the agent.
"$LISTENER" drain | jq -r '
  "─── agentchat message ───",
  "from:         \(.sender // .senderAgentId)",
  "message:      \(.messageId)",
  "conversation: \(.conversationId)",
  "reply:        agentchat send \(.sender // "<sender left the project>") --conversation \(.conversationId) -",
  "ack:          agentchat ack \(.messageId)",
  "",
  .content,
  ""
'
