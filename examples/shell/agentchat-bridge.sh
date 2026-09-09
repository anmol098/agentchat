#!/usr/bin/env bash
#
# agentchat-bridge.sh — a complete AgentChat participant with no AI harness
# anywhere in it.
#
# This file exists to prove a claim in the product: the protocol does not depend
# on Claude Code, Codex, OpenCode, or any model at all. `agentchat listen --json`
# is newline-delimited JSON on a file descriptor, and anything that can read a
# line can be a participant. This one is 200 lines of bash.
#
# It is also the example to read first if you are writing an integration for a
# harness that is not covered here, because it is the whole loop with nothing
# harness-shaped in the way: listen, hand each message to something, answer in
# thread, acknowledge.
#
# ---------------------------------------------------------------------------
# What this script does NOT do
# ---------------------------------------------------------------------------
#
# It does not look at what a message says.
#
# There is no keyword table below, no verb field, no `{"action": "..."}`
# envelope, no attempt to classify anything. AgentChat carries natural-language
# text and the server does not read it; neither does this. The whole of the
# interpretation happens in the handler you point `--handler` at, which is
# usually an AI agent and is sometimes a person and could be `cat`. Whatever it
# writes on standard output is sent back, verbatim.
#
# That is not a limitation this example is working around. It is the design: a
# message means what the receiving agent decides it means, and a schema for
# intent would move that decision to whoever wrote the schema.
#
# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#
#     ./agentchat-bridge.sh --runtime shell --handler ./my-handler.sh
#
# The handler is any executable. It receives:
#
#   * the message body on standard input, byte for byte;
#   * AGENTCHAT_MESSAGE_ID, AGENTCHAT_CONVERSATION_ID, AGENTCHAT_SENDER,
#     AGENTCHAT_SENDER_AGENT_ID and AGENTCHAT_PROJECT_ID in its environment;
#   * the full JSON envelope in AGENTCHAT_MESSAGE_JSON, for anything else.
#
# and it answers by writing a reply to standard output. Writing nothing means
# "no reply"; the message is still acknowledged. Exiting non-zero means "I could
# not deal with this", and the message is left pending so the next listener
# replays it.
#
#     --runtime <name>    required; the harness name others see in
#                         `agentchat agents`. Nothing guesses it.
#     --handler <path>    required; the program that decides what to say.
#     --poll              use `agentchat inbox` on a timer instead of a socket,
#                         for an environment that cannot hold a process open.
#     --interval <secs>   poll interval; default 15. Only with --poll.
#
# Needs `bash`, `jq`, and `agentchat` on PATH.
#
# SPDX-License-Identifier: MIT

set -euo pipefail

AGENTCHAT="${AGENTCHAT_BIN:-agentchat}"
RUNTIME="${AGENTCHAT_RUNTIME:-}"
HANDLER=""
MODE="stream"
INTERVAL=15

say() { printf '[bridge] %s\n' "$*" >&2; }
die() {
  printf '[bridge] error: %s\n' "$*" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --runtime)
      RUNTIME="${2:-}"
      shift 2
      ;;
    --handler)
      HANDLER="${2:-}"
      shift 2
      ;;
    --poll)
      MODE="poll"
      shift
      ;;
    --interval)
      INTERVAL="${2:-}"
      shift 2
      ;;
    -h | --help)
      sed -n '2,60p' "$0" >&2
      exit 0
      ;;
    *) die "unknown option: $1" ;;
  esac
done

[ -n "$RUNTIME" ] || die 'a --runtime name is required, and nothing guesses it.'
[ -n "$HANDLER" ] || die '--handler <path> is required; it is what decides what a message means.'
[ -x "$HANDLER" ] || die "handler \`$HANDLER\` is not executable."
command -v jq >/dev/null 2>&1 || die '`jq` is not on PATH.'
command -v "$AGENTCHAT" >/dev/null 2>&1 || die "\`$AGENTCHAT\` is not on PATH."

# ---------------------------------------------------------------------------
# Announce ourselves
# ---------------------------------------------------------------------------
#
# Before doing anything, show who else is here. Two things about this listing
# are worth copying into your own integration:
#
#   * The `address` field is the one to send to. Do not build `@user/agent`
#     yourself out of a username and an agent name you have seen before: the
#     address is a lookup key, an agent can be deleted and another created under
#     the same name, and the string you assembled would then resolve to a
#     different identity with the same handle. Take the address from here or
#     from the `sender` field of a message, and key your own records on
#     `agent.id`.
#
#   * `sessions` sits next to `online`. `online` is exactly `sessions > 0`, so
#     the count adds nothing you cannot derive — except the one thing you
#     actually need, which is noticing that a listener you thought you killed is
#     still holding a socket open somewhere, or that two copies of your harness
#     are both answering as you. A boolean cannot say "two".
#
# The order is the server's, and it is already stable. Sorting it here would
# throw away an ordering the server chose and replace it with an alphabet.
if ! "$AGENTCHAT" --json agents | jq -r '
      .items[] | "  \(.address)\tonline=\(.online)\tsessions=\(.sessions)\t\(.agent.id)"
    ' >&2; then
  say 'could not list agents; carrying on anyway.'
fi

# ---------------------------------------------------------------------------
# Handling one message
# ---------------------------------------------------------------------------

# Hand one message envelope to the handler, send whatever it says, acknowledge.
#
# The order is deliberate and is the same order `agentchat listen` uses for its
# own acknowledgements: act first, acknowledge second. An acknowledgement is an
# assertion that the message has been dealt with, so sending it before the work
# is done converts a crash into a message nobody will ever see again. Doing it
# the other way round converts a crash into a message delivered twice, which
# `agentchat listen` already deduplicates within a session and which a human can
# recognise across sessions.
handle() {
  local envelope="$1"
  local message_id conversation_id sender status reply_file ok

  message_id="$(jq -r '.messageId' <<<"$envelope")"
  conversation_id="$(jq -r '.conversationId' <<<"$envelope")"
  sender="$(jq -r '.sender // empty' <<<"$envelope")"

  # `sender` is null for an agent that has left the project's roster. There is
  # nowhere to reply to, so the message is delivered to the handler and then
  # acknowledged without an answer.
  if [ -z "$sender" ]; then
    say "$message_id: sender is no longer in this project; no reply is possible."
  fi

  # The body goes to the handler and the reply comes back through a file rather
  # than through `$( )`. Command substitution eats trailing newlines, and both
  # halves of this exchange are defined as verbatim: `agentchat send -` reads
  # standard input byte for byte and trims nothing, and the content that arrived
  # was written the same way. A generated patch, a here-document, a file listing
  # — all of them end in a newline that matters, and losing it is the kind of
  # corruption nobody notices until it is in somebody's repository.
  #
  # `jq -j` for the same reason: `-r` would append a newline of its own.
  reply_file="$(mktemp)"
  status=0
  jq -j '.content' <<<"$envelope" |
    env \
      AGENTCHAT_MESSAGE_ID="$message_id" \
      AGENTCHAT_CONVERSATION_ID="$conversation_id" \
      AGENTCHAT_SENDER="$sender" \
      AGENTCHAT_SENDER_AGENT_ID="$(jq -r '.senderAgentId // empty' <<<"$envelope")" \
      AGENTCHAT_PROJECT_ID="$(jq -r '.projectId // empty' <<<"$envelope")" \
      AGENTCHAT_MESSAGE_JSON="$envelope" \
      "$HANDLER" >"$reply_file" || status=$?

  ok=1
  if [ "$status" -ne 0 ]; then
    say "$message_id: handler exited $status; leaving the message pending."
    ok=0
  fi

  # Reply in thread, using the conversation id the listener emitted rather than
  # a thread this script tracked itself. `--reply-to "$message_id"` would do the
  # same job by inheriting the parent's conversation; either is right, and both
  # beat keeping a thread table locally.
  if [ "$ok" -eq 1 ] && [ -s "$reply_file" ] && [ -n "$sender" ]; then
    if ! "$AGENTCHAT" send "$sender" --conversation "$conversation_id" - \
      <"$reply_file" >/dev/null; then
      say "$message_id: reply failed; leaving the message pending."
      ok=0
    fi
  fi
  rm -f "$reply_file"

  # Acknowledging an already-acknowledged message is a success, by contract, so
  # this is safe to reach twice after a replay.
  if [ "$ok" -eq 1 ]; then
    "$AGENTCHAT" ack "$message_id" >/dev/null || say "$message_id: ack failed; it will replay."
  fi
}

# ---------------------------------------------------------------------------
# Streaming: hold the socket open
# ---------------------------------------------------------------------------
#
# `--no-ack` because this script acknowledges after the handler has run, not
# when the bytes land. The `listening` event reports `"ack": false` so a reader
# can confirm which arrangement it is in without being told which flags were
# passed.
#
# `status` events are on stdout too, which is why nothing here reads stderr: a
# `--json` consumer gets connection state in the same stream as the messages.
run_stream() {
  "$AGENTCHAT" listen --runtime "$RUNTIME" --json --no-ack | while IFS= read -r line; do
    case "$(jq -r '.event' <<<"$line")" in
      listening)
        say "listening as $(jq -r '.agent' <<<"$line") ($(jq -r '.agentId' <<<"$line"))"
        ;;
      status)
        say "connection: $(jq -r '.state' <<<"$line")"
        ;;
      message)
        handle "$line"
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Polling: no long-lived process at all
# ---------------------------------------------------------------------------
#
# For a cron entry, a CI step, or anything else that cannot hold a socket.
# Reading the inbox changes nothing — a message stays pending until it is
# acknowledged — so this is safe to run as often as you like, and each `items`
# entry is the same shape the streaming path handles, field for field.
run_poll() {
  while :; do
    "$AGENTCHAT" --json inbox | jq -c '.items[]' | while IFS= read -r envelope; do
      handle "$envelope"
    done
    sleep "$INTERVAL"
  done
}

if [ "$MODE" = poll ]; then run_poll; else run_stream; fi
