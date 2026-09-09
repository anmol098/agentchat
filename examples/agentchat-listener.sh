#!/usr/bin/env bash
#
# agentchat-listener.sh — keep an `agentchat listen` process alive, spool what
# it emits, and hand it to a coding agent one message at a time.
#
# Copy this file into your repository. It has no dependencies beyond `bash`,
# `jq` and the `agentchat` binary, it never writes anything but the messages it
# was asked for to standard output, and every subcommand is safe to run twice.
#
# ---------------------------------------------------------------------------
# The one idea
# ---------------------------------------------------------------------------
#
# AgentChat moves text between agents. It does not interpret it. There is no
# schema for intent, no verb field, no command envelope, and nothing here
# inspects `content` for a keyword — because the agent on the other end is the
# thing that decides what a message means. A message that says "can you rebase
# this?" is a request only because a reader chose to read it that way.
#
# So this script's job stops at delivery. It gets each message out of the
# socket, onto a spool, and in front of the agent, with the identifiers needed
# to answer. What happens next is the agent's judgement, not this file's.
#
# ---------------------------------------------------------------------------
# Why a spool and not a pipe
# ---------------------------------------------------------------------------
#
# `agentchat listen` blocks. A coding agent runs in turns: it is alive while it
# is thinking and gone in between, and it cannot hold the read end of a pipe
# across that gap. So the listener is supervised in the background and appends
# newline-delimited JSON to a file; the agent runs `drain` at the start of a
# turn and gets everything that arrived while it was away.
#
# The listener runs with `--no-ack` deliberately. `agentchat listen` would
# otherwise acknowledge each message the moment its bytes reach standard output,
# which here means "the moment it reached the spool" — before any agent has read
# it, let alone acted on it. With `--no-ack` the acknowledgement is yours, and
# the right time to send it is after the agent has done something about the
# message:
#
#     agentchat ack "$message_id"
#
# Until then the message stays pending, and a listener that starts after a crash
# replays it. That is the trade this script is making on your behalf: a message
# handled twice is a nuisance, a message dropped silently is a bug you find out
# about from somebody else.
#
# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------
#
#     ./agentchat-listener.sh start --runtime claude-code
#     ./agentchat-listener.sh drain          # NDJSON message events, once each
#     ./agentchat-listener.sh status         # is it up, and how many sessions
#     ./agentchat-listener.sh peers          # who else is reachable here
#     ./agentchat-listener.sh stop
#     ./agentchat-listener.sh reset          # forget the spool (stopped only)
#
# `--runtime` is required by `agentchat listen` and is required here for the
# same reason: it is metadata everyone in the project reads in `agentchat
# agents`, and a guess would be wrong some of the time and authoritative all of
# the time. Set `AGENTCHAT_RUNTIME` instead if you prefer.
#
# State lives in `.agentchat/run/` by default. Add that directory to your
# `.gitignore`: it holds a spool, a pid and a log, all of them local facts.
#
# SPDX-License-Identifier: MIT

set -euo pipefail

STATE_DIR="${AGENTCHAT_STATE_DIR:-.agentchat/run}"
SPOOL="$STATE_DIR/listen.ndjson"
OFFSET="$STATE_DIR/offset"
PIDFILE="$STATE_DIR/listen.pid"
CHILDFILE="$STATE_DIR/listen.child.pid"
LOGFILE="$STATE_DIR/listen.stderr.log"
IDENTITY="$STATE_DIR/identity.json"
SEEN="$STATE_DIR/seen.txt"

AGENTCHAT="${AGENTCHAT_BIN:-agentchat}"

# Longest wait between restart attempts, in seconds. `agentchat listen`
# reconnects a dropped socket by itself; this backoff only covers the case where
# the process exited altogether.
MAX_BACKOFF=30

say() { printf '[agentchat-listener] %s\n' "$*" >&2; }
die() {
  printf '[agentchat-listener] error: %s\n' "$*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || die "\`$1\` is not on PATH; this script needs it."
}

# ---------------------------------------------------------------------------
# The supervisor
# ---------------------------------------------------------------------------

# Restart the listener until it exits for a reason a restart cannot fix.
#
# The exit codes are a published interface (`agentchat --help`, docs/cli.md) and
# each one above 1 exists because it has a different automatable remedy:
#
#   0  clean shutdown — a signal, or a reader that closed the pipe. Stop.
#   1  generic failure — may be transient. Back off and try again.
#   2  usage error — the invocation is wrong. Running it again cannot help.
#   3  authentication required — needs `agentchat login`. A human, not a retry.
#   4  no project or agent context — needs configuration written. Same.
#
# Backing off against a refusal that will repeat forever produces a process that
# looks like a working listener and delivers nothing, which is strictly worse
# than an error, so 2, 3 and 4 stop here and say why.
supervise() {
  local runtime="$1"
  local backoff=1
  local child=0
  local code=0
  local stopping=0

  # Two things have to happen when this supervisor is asked to stop, and getting
  # either one wrong leaves a live session behind that nobody owns:
  #
  #   * the listener has to be killed too, or `stop` orphans it;
  #   * the loop has to end, or the next iteration starts a *replacement*
  #     listener — a stop that visibly succeeds and reconnects a second later.
  #
  # `wait` returns as soon as a trap fires, before the child has necessarily
  # gone, so `stopping` is what distinguishes "the listener died" from "we were
  # told to stop" once control comes back.
  trap 'stopping=1; if [ "$child" -ne 0 ]; then kill "$child" 2>/dev/null || true; fi' TERM INT

  while :; do
    code=0
    "$AGENTCHAT" listen --runtime "$runtime" --json --no-ack >>"$SPOOL" 2>>"$LOGFILE" &
    child=$!
    printf '%s\n' "$child" >"$CHILDFILE"
    wait "$child" || code=$?
    if [ "$stopping" -eq 1 ]; then
      wait "$child" 2>/dev/null || true
      child=0
      rm -f "$CHILDFILE"
      return 0
    fi
    child=0
    rm -f "$CHILDFILE"

    case "$code" in
      0)
        say 'listener exited cleanly; supervisor stopping.'
        return 0
        ;;
      2 | 3 | 4)
        say "listener exited $code, which a retry cannot fix; see $LOGFILE."
        return "$code"
        ;;
      *)
        say "listener exited $code; retrying in ${backoff}s."
        sleep "$backoff"
        backoff=$((backoff * 2))
        if [ "$backoff" -gt "$MAX_BACKOFF" ]; then backoff="$MAX_BACKOFF"; fi
        ;;
    esac
  done
}

# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------

# Record which agent this spool belongs to, and say so when it changes.
#
# An address is not an identity. `@you/backend` is a name and a name can be
# given away: delete the agent, create another called `backend`, and the address
# resolves again — to a different `agentId`, with none of the old one's history.
# Anything you cached against the address is now about somebody else.
#
# So this records the `agentId` from the `listening` event and complains when it
# moves. Do the same with your own state: key it on `agentId`, `messageId` and
# `conversationId`, never on an address or a name.
#
# @param $1 - Ignore everything up to and including this line of the spool. The
#             spool outlives any one listener, so without a floor this reads the
#             *previous* run's announcement and concludes nothing has changed —
#             which is the one case it exists to catch.
remember_identity() {
  local from="${1:-0}"
  local line agent_id previous
  line="$(awk -v s="$((from + 1))" 'NR >= s' "$SPOOL" 2>/dev/null |
    grep '"event":"listening"' | tail -n 1 || true)"
  [ -n "$line" ] || return 0

  agent_id="$(printf '%s' "$line" | jq -r '.agentId')"
  if [ -f "$IDENTITY" ]; then
    previous="$(jq -r '.agentId // empty' "$IDENTITY")"
    if [ -n "$previous" ] && [ "$previous" != "$agent_id" ]; then
      say "this address now answers as $agent_id, not $previous."
      say 'that is a different identity at the same name; re-resolve anything you cached.'
    fi
  fi
  printf '%s' "$line" | jq -c \
    '{agentId, agent, projectId, sessionId, runtime, ack}' >"$IDENTITY"
}

# ---------------------------------------------------------------------------
# Subcommands
# ---------------------------------------------------------------------------

running() {
  [ -f "$PIDFILE" ] || return 1
  local pid
  pid="$(cat "$PIDFILE")"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  local runtime="${AGENTCHAT_RUNTIME:-}"
  while [ $# -gt 0 ]; do
    case "$1" in
      --runtime)
        runtime="${2:-}"
        shift 2
        ;;
      --runtime=*)
        runtime="${1#--runtime=}"
        shift
        ;;
      *) die "unknown option for start: $1" ;;
    esac
  done
  [ -n "$runtime" ] ||
    die 'start needs --runtime <name> (or AGENTCHAT_RUNTIME). Nothing guesses it.'

  if running; then
    say "already running as pid $(cat "$PIDFILE")."
    return 0
  fi

  mkdir -p "$STATE_DIR"
  : >>"$SPOOL"
  : >>"$LOGFILE"
  [ -f "$OFFSET" ] || printf '0\n' >"$OFFSET"

  # Where the spool ends *now*, so the announcement this start is about to
  # produce can be told apart from the last one's.
  local before
  before="$(wc -l <"$SPOOL" | tr -d ' ')"

  # `setsid` where it exists, so a supervisor started from inside a coding
  # agent's shell survives that shell going away. macOS has no `setsid`;
  # `nohup` plus a detached background job is close enough there.
  #
  # The supervisor's own commentary goes to the log rather than to /dev/null.
  # Its most important line is the one that says the listener exited for a
  # reason a retry cannot fix, and a message explaining why nothing is arriving
  # is worth nothing if it is discarded.
  if command -v setsid >/dev/null 2>&1; then
    setsid "$0" __supervise "$runtime" >/dev/null 2>>"$LOGFILE" &
  else
    nohup "$0" __supervise "$runtime" >/dev/null 2>>"$LOGFILE" &
  fi
  printf '%s\n' "$!" >"$PIDFILE"
  disown 2>/dev/null || true

  say "started (pid $(cat "$PIDFILE"), runtime $runtime)."

  # Wait for the handshake, so `start` can report the identity it got — and, more
  # usefully, so it can fail loudly when there is not going to be one.
  #
  # The supervisor exiting during this wait is the interesting case: it means
  # `agentchat listen` refused in a way a retry cannot fix, which is almost
  # always a missing server, missing credentials, or a directory that is not
  # linked to a project. Waiting out the timeout and then reporting success
  # would leave a harness believing it is reachable when nothing is listening,
  # which is the exact failure this script is meant to prevent.
  local waited=0
  while [ "$waited" -lt 50 ]; do
    if awk -v s="$((before + 1))" 'NR >= s' "$SPOOL" 2>/dev/null |
      grep -q '"event":"listening"'; then
      remember_identity "$before"
      return 0
    fi
    if ! running; then
      rm -f "$PIDFILE"
      say 'the listener stopped before it connected. The last thing it said:'
      tail -n 3 "$LOGFILE" >&2 || true
      awk -v s="$((before + 1))" 'NR >= s' "$SPOOL" 2>/dev/null |
        jq -c 'select(has("error")) | .error' >&2 || true
      return 1
    fi
    sleep 0.1
    waited=$((waited + 1))
  done

  say 'no handshake yet; the listener is still trying. `status` will say more.'
  remember_identity "$before"
}

reap() {
  local pid="$1"
  local waited=0
  kill "$pid" 2>/dev/null || true
  while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 100 ]; do
    sleep 0.1
    waited=$((waited + 1))
  done
}

# Stop the supervisor, and then make sure the listener really went with it.
#
# The second half is not belt and braces. The supervisor forwards the signal,
# but if it were killed with SIGKILL, or died on its own between spawning the
# listener and installing its trap, the listener survives — and a surviving
# listener holds a live session that `agentchat agents` will keep counting. That
# is the failure this whole script's session count exists to make visible, so it
# would be a poor showing to cause it here.
cmd_stop() {
  local stopped=0
  if running; then
    reap "$(cat "$PIDFILE")"
    stopped=1
  fi
  rm -f "$PIDFILE"

  if [ -f "$CHILDFILE" ]; then
    local child
    child="$(cat "$CHILDFILE")"
    if [ -n "$child" ] && kill -0 "$child" 2>/dev/null; then
      say 'the listener outlived its supervisor; stopping it too.'
      reap "$child"
      stopped=1
    fi
    rm -f "$CHILDFILE"
  fi

  if [ "$stopped" -eq 1 ]; then
    say 'stopped.'
    say "run \`$0 status\` to confirm the server agrees the session is gone."
  else
    say 'not running.'
  fi
}

# Print the message events nobody has taken yet, one JSON object per line.
#
# Standard output is nothing but those objects, so this composes: pipe it into
# `while read -r line`, into `jq`, into a file, into your agent. Everything this
# script wants to tell a human goes to standard error, which is the same
# discipline `agentchat` itself keeps.
#
# ## Why the offset is not enough on its own
#
# Delivery is at-least-once. `agentchat listen` suppresses a replayed message
# for the life of one process, but a supervisor restart is a new process with a
# new deduplication table, and the server replays anything still unacknowledged
# on the next handshake — which is exactly the arrangement `--no-ack` puts us in.
# So the same message can legitimately appear in this spool twice.
#
# `seen.txt` is the fix, and it is keyed on `messageId` for the same reason
# everything else here is keyed on an identifier: a message id is minted once and
# means one thing forever, where an address, a name or a position in a file are
# all things that can come to mean something else.
#
# The offset advances only after the lines have been written, so a consumer that
# dies mid-drain sees them again rather than losing them.
cmd_drain() {
  [ -f "$SPOOL" ] || return 0
  : >>"$SEEN"
  local offset total
  offset="$(cat "$OFFSET" 2>/dev/null || printf '0')"
  total="$(wc -l <"$SPOOL" | tr -d ' ')"
  [ "$total" -gt "$offset" ] || return 0

  # One `awk` rather than `tail | head`: the listener is appending to this file
  # while we read it, and a `head` that stops early sends SIGPIPE upstream and
  # turns a perfectly ordinary race into a failed pipeline.
  #
  # `fromjson?` drops a line that is not whole JSON. That can only be a torn
  # final write, and the message it belonged to is still unacknowledged, so the
  # next handshake replays it rather than it being lost here.
  awk -v start="$((offset + 1))" -v end="$total" 'NR >= start && NR <= end' "$SPOOL" |
    jq -cR 'fromjson? | select(.event == "message")' |
    while IFS= read -r line; do
      local id
      id="$(jq -r '.messageId' <<<"$line")"
      if grep -qxF "$id" "$SEEN"; then continue; fi
      printf '%s\n' "$id" >>"$SEEN"
      printf '%s\n' "$line"
    done

  printf '%s\n' "$total" >"$OFFSET"
}

# Say whether the listener is up — and how many sessions the server thinks this
# agent has.
#
# The session count is the point of this subcommand. `online` is a boolean and a
# boolean cannot tell you that the listener you killed last week is still
# holding a socket open from a terminal you closed, or that two copies of your
# harness are both answering as you. A count can. `online` is exactly
# `sessions > 0`, so it never disagrees; it just says less.
cmd_status() {
  if running; then
    say "supervisor: running (pid $(cat "$PIDFILE"))"
  else
    say 'supervisor: not running'
  fi
  if [ -f "$IDENTITY" ]; then jq -c . "$IDENTITY" >&2; fi

  local agent_id
  agent_id="$(jq -r '.agentId // empty' "$IDENTITY" 2>/dev/null || true)"
  if [ -z "$agent_id" ]; then
    agent_id="$("$AGENTCHAT" --json status 2>/dev/null | jq -r '.agent.id // empty' || true)"
  fi
  if [ -z "$agent_id" ]; then
    say 'no agent id on file yet; start the listener, or run `agentchat status`.'
    return 0
  fi

  # `--arg` rather than string interpolation, so an id is never spliced into a
  # jq program.
  #
  # Redirection order matters. `>&2` points stdout at the terminal's stderr
  # first, and only then is jq's own stderr discarded, so the listing is still
  # printed and a failure is reported once — in our words — rather than twice.
  "$AGENTCHAT" --json agents |
    jq -r --arg id "$agent_id" '
      .items[] | select(.agent.id == $id)
      | "\(.address)  online=\(.online)  sessions=\(.sessions)  id=\(.agent.id)"
    ' >&2 2>/dev/null || say 'could not reach the server for the session count.'
}

# Who else is here, in the server's order.
#
# Two rules are load bearing:
#
#   * Take the address from this output. Never assemble `@user/agent` yourself
#     from a username and a name you remember — that string is a lookup key, and
#     a key you built from stale parts resolves to whoever holds those names now.
#   * Do not sort it. The server's order is already total and stable, so sorting
#     buys nothing and costs the ordering the server chose to express.
cmd_peers() {
  "$AGENTCHAT" --json agents | jq -r '
    .items[]
    | "\(.address)\tonline=\(.online)\tsessions=\(.sessions)\t\(.agent.id)"
  '
}

cmd_reset() {
  if running; then die 'stop the listener before resetting its spool.'; fi
  rm -f "$SPOOL" "$OFFSET" "$LOGFILE" "$SEEN"
  say 'spool cleared. Anything unacknowledged is replayed on the next start.'
}

usage() {
  cat >&2 <<'EOF'
Usage: agentchat-listener.sh <command>

  start --runtime <name>   supervise `agentchat listen` in the background
  stop                     stop it, ending the session
  status                   supervisor state, plus online and session count
  drain                    NDJSON message events not yet taken, on stdout
  peers                    everyone reachable in this project, server order
  reset                    forget the spool (only while stopped)

Acknowledge a message once your agent has acted on it:

  agentchat ack <messageId>
EOF
}

main() {
  require jq
  require "$AGENTCHAT"

  local command="${1:-}"
  if [ $# -gt 0 ]; then shift; fi

  case "$command" in
    start) cmd_start "$@" ;;
    stop) cmd_stop ;;
    status) cmd_status ;;
    drain) cmd_drain ;;
    peers) cmd_peers ;;
    reset) cmd_reset ;;
    __supervise) supervise "$1" ;;
    -h | --help | help) usage ;;
    *)
      usage
      exit 2
      ;;
  esac
}

main "$@"
