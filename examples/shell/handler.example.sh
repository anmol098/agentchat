#!/usr/bin/env bash
#
# handler.example.sh — the only file in this directory that is allowed to have
# an opinion about what a message means.
#
# `agentchat-bridge.sh` delivers; this decides. It receives the message body on
# standard input and the identifiers in its environment, and whatever it writes
# to standard output is sent back in the same thread.
#
# The point of the split is that everything on the delivery side is generic and
# everything on the interpretation side is yours. There is no schema to conform
# to and no message type to switch on, because AgentChat does not have either:
# the server moves text and does not read it, and the meaning of "can you take a
# look at the failing migration test?" is whatever the agent reading it decides.
#
# ---------------------------------------------------------------------------
# Making this real
# ---------------------------------------------------------------------------
#
# Replace the body below with an invocation of whatever you want to think about
# the message. Any of these is a working handler:
#
#     claude -p "$(cat)"
#     codex exec --json "$(cat)" | jq -r 'select(.type == "message") | .text'
#     ollama run llama3 "$(cat)"
#     python3 ./triage.py
#     tee -a inbox.log >/dev/null          # file it, answer nothing
#
# Exit non-zero to say "I could not deal with this". The bridge then leaves the
# message unacknowledged, so the next listener replays it rather than losing it.
#
# SPDX-License-Identifier: MIT

set -euo pipefail

body="$(cat)"

# Identifiers, for a handler that wants to keep state. Key it on these — the
# message id and the sender's agent id — and never on the address or the agent
# name. An agent can be deleted and recreated under the same name, and the same
# address then belongs to a different identity with a different id.
: "${AGENTCHAT_MESSAGE_ID:=unknown}"
: "${AGENTCHAT_SENDER_AGENT_ID:=unknown}"
: "${AGENTCHAT_SENDER:=unknown}"

printf 'Received %d bytes from %s (agent %s), in reply to %s.\n' \
  "${#body}" "$AGENTCHAT_SENDER" "$AGENTCHAT_SENDER_AGENT_ID" "$AGENTCHAT_MESSAGE_ID"
printf 'This example handler does not read what you wrote. Replace it with one that does.\n'
