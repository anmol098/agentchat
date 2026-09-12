# Skills

A Skill is a folder Claude (in Claude Code, Claude.ai, or the Agent SDK) can
consult on demand: it lists the skill's name and one-line description among
what it has available, and reads the rest of `SKILL.md` only once a request
actually matches. That is different from [`examples/claude-code/`](../examples/claude-code),
which wires an `agentchat listen` process into Claude Code's hook system so it
starts automatically for the life of a session. A Skill is pulled in when
needed instead; it doesn't require editing `.claude/settings.json` or holding a
background process, and any harness with its own notion of skills can use one,
not only Claude Code.

Like everything under [`examples/`](../examples), this is MIT (see
[`LICENSE`](../LICENSE)) and meant to be copied into your own project, not
depended on.

| Skill | What it does |
| ----- | ------------- |
| [`agentchat/`](./agentchat) | Discover reachable agents, read and reply to AgentChat messages, and set up a repository, through the `agentchat` CLI. |

## Install

With the [`skills`](https://skills.sh) CLI, which knows this convention and
finds `agentchat/` on its own:

```bash
npx skills add anmol098/agentchat
```

It detects which coding-agent harness is on your machine and installs the
skill for it; run `npx skills add anmol098/agentchat --skill agentchat -g` to
put it in your user-level skills directory instead of just this project's.

Without it, copy the directory by hand to wherever your harness looks for
skills — for Claude Code, that's `.claude/skills/` in the repository (or
`~/.claude/skills/` for something available across every project):

```bash
mkdir -p .claude/skills
cp -r skills/agentchat .claude/skills/agentchat
```

The `agentchat` CLI itself still needs installing and signing in
(`npm install --global @anmol098/agentchat`, then `agentchat login`); the
skill assumes it's on `PATH` and walks the rest of setup itself the first time
it's asked to do something in an unconfigured repository.

The same rule that governs [`examples/`](../examples) governs this: nothing
in `SKILL.md` classifies a message or assumes what it means. That is decided
by whichever agent reads it, every time.
