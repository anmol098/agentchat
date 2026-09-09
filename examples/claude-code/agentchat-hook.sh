#!/usr/bin/env bash
#
# agentchat-hook.sh — the glue between Claude Code's hook system and an
# AgentChat listener.
#
# Claude Code runs hooks at fixed points in a session and reads a JSON document
# back from each one. Three of those points are all this integration needs:
#
#   SessionStart       start the listener, so the agent is reachable for as long
#                      as the session lasts.
#   UserPromptSubmit   attach anything that arrived while the user was typing.
#   Stop               the agent believes it is finished. If a message came in
#                      during the turn, say so and let it keep going.
#
# The hook receives its event payload as JSON on standard input and answers with
# JSON on standard output. This script is invoked once per event with the event
# name as its only argument; see settings.json in this directory for the wiring.
#
# ---------------------------------------------------------------------------
# What this hook does not do
# ---------------------------------------------------------------------------
#
# It does not decide what any message means. It puts the text in front of Claude
# with the identifiers needed to answer, and stops. There is no rule here that
# says a message ending in a question mark is a question or that one containing
# "urgent" gets priority, because AgentChat has no such notion: the server moves
# text and does not read it, and the reader is the thing that decides. A hook
# that classified messages would be quietly inventing a protocol on top of one
# that deliberately does not have one.
#
# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
#
#     cp examples/agentchat-listener.sh .claude/
#     cp examples/claude-code/agentchat-hook.sh .claude/
#     chmod +x .claude/agentchat-listener.sh .claude/agentchat-hook.sh
#     # merge examples/claude-code/settings.json into .claude/settings.json
#     # append examples/claude-code/CLAUDE.agentchat.md to your CLAUDE.md
#
# Then set the runtime name once, in `.claude/settings.json`:
#
#     "env": { "AGENTCHAT_RUNTIME": "claude-code" }
#
# SPDX-License-Identifier: MIT

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LISTENER="${AGENTCHAT_LISTENER:-$HERE/agentchat-listener.sh}"
RUNTIME="${AGENTCHAT_RUNTIME:-claude-code}"

event="${1:-}"

# Read the hook payload if there is one. Nothing below needs it except `Stop`,
# which needs `stop_hook_active`.
payload='{}'
if [ ! -t 0 ]; then payload="$(cat || true)"; fi
if [ -z "$payload" ]; then payload='{}'; fi

# Render the drained messages as text for Claude to read.
#
# Everything a reply needs is in the message envelope, so the identifiers are
# printed beside the body rather than left for the agent to look up: the
# conversation id threads the answer, and the message id is what gets
# acknowledged once the agent has actually done something about it.
render() {
  jq -r '
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
}

case "$event" in
  SessionStart)
    # Idempotent: a second Claude Code window in the same repository finds the
    # listener already running and leaves it alone. `status` will show one
    # session, not two, which is the point of watching that count.
    "$LISTENER" start --runtime "$RUNTIME" >&2 || true

    jq -n --arg text "$(
      {
        printf 'An AgentChat listener is running for this repository.\n'
        printf 'Messages from other agents will be attached to your turns automatically.\n'
        printf 'Acknowledge each one with `agentchat ack <messageId>` once you have acted on it.\n'
        "$LISTENER" peers 2>/dev/null | sed 's/^/  /' || true
      } 2>/dev/null
    )" '{
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: $text
      }
    }'
    ;;

  UserPromptSubmit)
    messages="$("$LISTENER" drain 2>/dev/null | render || true)"
    if [ -z "$messages" ]; then
      exit 0
    fi
    jq -n --arg text "$messages" '{
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: ("Messages arrived on AgentChat while you were working. " +
          "Read them and decide for yourself what, if anything, they ask of you.\n\n" + $text)
      }
    }'
    ;;

  Stop)
    # `stop_hook_active` is true when this hook already blocked once and Claude
    # is stopping again. Blocking then would loop forever, so this yields — the
    # next `UserPromptSubmit` picks up anything still waiting.
    if [ "$(jq -r '.stop_hook_active // false' <<<"$payload" 2>/dev/null)" = true ]; then
      exit 0
    fi

    messages="$("$LISTENER" drain 2>/dev/null | render || true)"
    if [ -z "$messages" ]; then
      exit 0
    fi

    # `decision: block` hands the reason back to Claude and lets it continue,
    # which is how a message that arrived mid-turn gets handled without the user
    # having to type anything.
    jq -n --arg text "$messages" '{
      decision: "block",
      reason: ("A message arrived on AgentChat during this turn. Read it and decide " +
        "what it asks of you; reply in the conversation it names if a reply is " +
        "warranted, then acknowledge it.\n\n" + $text)
    }'
    ;;

  *)
    printf 'agentchat-hook.sh: unknown event %s\n' "${event:-<none>}" >&2
    exit 2
    ;;
esac
