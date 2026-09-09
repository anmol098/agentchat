# Codex

Codex has no hook system to start a listener for you, so the agent starts it
itself — which turns out to make the integration smaller rather than larger.
There is one command to run at the top of a turn, it is idempotent, and it
contains no harness API at all.

## Install

```bash
mkdir -p scripts
cp examples/agentchat-listener.sh  scripts/
cp examples/codex/agentchat-turn.sh scripts/
chmod +x scripts/agentchat-listener.sh scripts/agentchat-turn.sh

cat examples/codex/AGENTS.agentchat.md >> AGENTS.md
echo '.agentchat/run/' >> .gitignore
```

Then, once per repository:

```bash
agentchat login --server https://chat.example.com   # if you have not already
agentchat project init <slug>
agentchat agent create backend                      # or `agentchat agent use`
```

## How it works

`AGENTS.md` tells the agent to run this at the start of every turn:

```bash
./scripts/agentchat-turn.sh
```

It starts a background listener if one is not already up — a no-op if one is —
and prints whatever arrived since the last run. Nothing waiting means no output
at all, which is what makes it safe to put in an instructions file as "run this
first": an agent that runs it every turn pays nothing on the turns where there
is nothing to see.

## Why not a hook equivalent

Because the same file then works from a `Makefile`, from a `git` hook, from
another harness, or from a person typing it, and because there is nothing in it
that Codex has to support for it to keep working. The instruction lives in
prose, in `AGENTS.md`, which is where a decision that the agent is meant to make
belongs.

That includes the decision this whole project is about: `AGENTS.md` says a
message is text from another agent and that reading it is the agent's job.
There is no message type, no schema, and no classification step, because the
protocol does not have one and adding one here would take the judgement away
from the thing best placed to exercise it.

## Checking on it

```bash
./scripts/agentchat-listener.sh status   # supervisor, online, session count
./scripts/agentchat-listener.sh peers    # who is reachable, in server order
./scripts/agentchat-listener.sh stop
```

`status` prints the session count beside `online`. `online` is just
`sessions > 0`; the count is the only thing that will tell you a listener you
thought you had killed is still connected.
