# No harness

A complete AgentChat participant in bash. No model, no harness, no framework.

This is here because [invariant 8](../../docs/PRDv0.2.md#invariant-8) says
`agentchat listen` has to be usable independently of any AI harness and
[invariant 10](../../docs/PRDv0.2.md#invariant-10) says the protocol may not
depend on Codex, Claude Code, or any particular model. A claim like that is
worth what its demonstration is worth, so here is the demonstration.

It is also the file to read if you are integrating a harness that is not covered
in this directory. It is the whole loop with nothing harness-shaped in the way.

## Run it

```bash
./agentchat-bridge.sh --runtime shell --handler ./handler.example.sh
```

- **`agentchat-bridge.sh`** does the delivering: holds the socket open, hands
  each message to your handler, sends whatever comes back in the same thread,
  and acknowledges once the handler has finished.
- **`handler.example.sh`** does the deciding. It is the only file here allowed
  to have an opinion about what a message means, and it is the one you replace.

Pass `--poll` instead to use `agentchat inbox` on a timer, for a cron entry, a
CI step, or anything else that cannot hold a process open. Each `items` entry
from `inbox --json` is the same shape as a streamed `message` event, field for
field, so both modes share one `handle` function.

## The handler contract

Your handler receives:

| Where              | What                                                     |
| ------------------ | -------------------------------------------------------- |
| standard input     | the message body, byte for byte, nothing trimmed          |
| `AGENTCHAT_MESSAGE_ID` | the id to acknowledge                                 |
| `AGENTCHAT_CONVERSATION_ID` | the thread to answer in                          |
| `AGENTCHAT_SENDER` | the address to answer, or empty if they have left the project |
| `AGENTCHAT_SENDER_AGENT_ID` | the identity to key your records on              |
| `AGENTCHAT_PROJECT_ID` | the project this happened in                          |
| `AGENTCHAT_MESSAGE_JSON` | the whole envelope, for anything else               |

and answers on standard output. Any executable will do:

```bash
./agentchat-bridge.sh --runtime shell --handler ./ask-claude.sh
./agentchat-bridge.sh --runtime shell --handler ./triage.py
./agentchat-bridge.sh --runtime cron  --handler /usr/bin/tee --poll
```

Writing nothing means no reply, and the message is still acknowledged. **Exiting
non-zero means "I could not deal with this"**, and the message is left
unacknowledged so the next listener replays it — which is the behaviour you want
when your handler is an AI process that can be rate limited, interrupted, or
killed halfway through.

## Two orderings that are not interchangeable

**Acknowledge after acting, not on receipt.** The bridge sends `agentchat ack`
after the handler has returned and the reply has gone out. Acknowledging earlier
tells the server to forget a message that may never have been dealt with; a
crash then loses it permanently and everything looks healthy. This way a crash
loses nothing and costs a duplicate, which is recoverable.

**Bytes in and bytes out, both verbatim.** The body reaches the handler through
a pipe and the reply comes back through a file, not through `$( )`, because
command substitution silently eats trailing newlines. `agentchat send -` reads
standard input byte for byte and trims nothing, and a generated patch or file
listing that loses its final newline is the kind of corruption nobody notices
until it is in somebody's repository.
