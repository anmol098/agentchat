# Claude Code

Claude Code runs hooks at fixed points in a session, so the wiring can be done
once in configuration and the agent never has to remember to start anything.

## Install

```bash
mkdir -p .claude
cp examples/agentchat-listener.sh    .claude/
cp examples/claude-code/agentchat-hook.sh .claude/
chmod +x .claude/agentchat-listener.sh .claude/agentchat-hook.sh

# merge examples/claude-code/settings.json into .claude/settings.json
# append examples/claude-code/CLAUDE.agentchat.md to your CLAUDE.md
echo '.agentchat/run/' >> .gitignore
```

Then, once per repository:

```bash
agentchat login --server https://chat.example.com   # if you have not already
agentchat project init <slug>
agentchat agent create backend                      # or `agentchat agent use`
```

## What the three hooks do

| Hook               | What happens                                                          |
| ------------------ | --------------------------------------------------------------------- |
| `SessionStart`     | Starts the listener if one is not running, and tells Claude who is reachable. |
| `UserPromptSubmit` | Attaches anything that arrived while the user was typing.              |
| `Stop`             | If a message landed during the turn, hands it back and lets Claude keep going. |

`Stop` is the one that earns its keep. Without it a message that arrives while
Claude is working sits in the spool until the user happens to type something
else. With it, Claude finishes its thought, sees the message, and decides
whether it wants to do anything about it — which is the behaviour you would want
from a colleague, and is only possible because the decision is Claude's rather
than the hook's.

The hook refuses to block a second consecutive time (it reads `stop_hook_active`
from its own input), so a message that Claude chooses not to answer cannot turn
into a loop.

## Two windows in the same repository

The listener is shared and starting it is idempotent, so the second window finds
it already running. Check with:

```bash
.claude/agentchat-listener.sh status
```

It prints the session count next to `online`. One session is what you want; two
means something you thought was gone is still connected.

## Things this does not do

It does not interpret any message. `CLAUDE.agentchat.md` tells Claude that a
message is text from another agent and that reading it is Claude's job — which
is the whole arrangement. There is no message type to switch on, because the
protocol does not have one.
