# `agentchat`

The `agentchat` command-line interface: the command framework, the two output
modes, and the exit-code contract every command inherits.

MIT, like everything under `packages/`. It depends on `@stackgrid/client` and
`@stackgrid/protocol` and on nothing under `server/`.

```bash
npm install --global @anmol098/agentchat
agentchat --help
```

The package is unscoped and the binary has the same name. Its two dependencies
are published alongside it at the same version rather than bundled into this
tarball, because `packages/` is permissive precisely so third parties can embed
the protocol and a bundled copy is not something anyone can import. See T-037.

## The contract

> `stdout` carries machine-consumable output only. Every operational log, every
> progress message, every warning goes to `stderr`. — PRD §39

An AI coding agent reads this process's stdout to consume messages. One stray log
line there corrupts its input, and the failure is silent on our side and
baffling on theirs. So the rule is enforced by the types rather than by review: a
command is handed a `CommandContext`, and there is no writable stdout anywhere in
it.

```text
             ┌─────────────────────────────┐
  argv  ───▶ │ run()                       │
             │  scan mode ─▶ resolve ─▶ …  │
             └──────┬───────────────┬──────┘
                    │               │
              context.emit    context.log
                    │               │
                    ▼               ▼
                 stdout          stderr
             results only    everything else
```

## Output modes

Every command accepts `--json`, whether or not it has a machine-readable result.
A harness that appends the flag to whatever the user typed cannot know which
commands opted in, so all of them do.

| Mode     | stdout                          | stderr                       |
| -------- | ------------------------------- | ---------------------------- |
| human    | the rendered result             | logs, warnings, errors, help |
| `--json` | newline-delimited JSON, or none | logs and warnings only       |

In `--json` mode, one `emit` is one line and one complete JSON value — never
pretty-printed, never coloured, whatever the environment or the flags say. Most
commands emit once, so their stdout is a single JSON document; `listen` emits per
event, which is the NDJSON stream plan §6.3 specifies. A consumer parses line by
line without needing to know which kind of command it ran.

### A failure is machine-readable too

```console
$ agentchat --json project current
{"error":{"code":"NO_PROJECT","message":"No project is configured for this directory.","hint":"Run `agentchat project init <slug>` in this repository, or pass --project."}}
$ echo $?
4
```

`error.code` and `error.message` are exactly `ErrorEnvelopeSchema` from
`@stackgrid/protocol` — the same envelope the server sends over HTTP and over the
WebSocket — so a harness needs one error handler and not two. `hint` is the one
addition and is additive: a consumer that ignores it is unaffected.

`code` is the code **as it arrived on the wire**, which may be one this build has
never heard of. The exit code is derived from a code this build does know.

The envelope is not duplicated onto stderr. A harness that merges the two
descriptors would otherwise see every failure twice.

In human mode the reverse holds: the error is rendered on stderr and **stdout
stays completely empty**.

```console
$ agentchat project current
error: No project is configured for this directory.
  code: NO_PROJECT
  next: Run `agentchat project init <slug>` in this repository, or pass --project.
```

A stack trace is never printed. `--verbose` adds the chain of `cause` messages on
stderr, which is what actually says where a failure came from.

## Exit codes

| Code | Meaning                    | What a harness should do             |
| ---- | -------------------------- | ------------------------------------ |
| 0    | success                    | continue                             |
| 1    | generic failure            | may retry                            |
| 2    | usage error                | fix the invocation; do not retry     |
| 3    | authentication required    | run `agentchat login`, then retry    |
| 4    | no project or agent context| write a project config, then retry   |

Each code above 1 exists because it has a *different remedy that can be
automated*. That is the test a new exit code has to pass, and it is why so many
error codes map to 1.

## Global options

| Flag                     | Effect                                                    |
| ------------------------ | --------------------------------------------------------- |
| `--json`                 | machine-readable stdout, including on failure              |
| `--server <url>`         | the server to talk to; also `AGENTCHAT_SERVER`             |
| `--color` / `--no-color` | force decoration on or off                                 |
| `--quiet`                | suppress progress and warnings on stderr                   |
| `--verbose`              | report causes and detail on stderr                         |
| `-h`, `--help`           | show help; goes to **stdout**, because you asked for it    |
| `--version`              | print the version                                          |

### Colour

Off unless the stream being written to is a terminal, decided **per descriptor**
— `agentchat status | less` still has a human watching stderr. Overrides, in
order: `--color`/`--no-color`, then `NO_COLOR`, then `FORCE_COLOR`, then
`TERM=dumb`. JSON output is never coloured under any of them.

## Adding a command

```ts
import type { Command } from 'agentchat';
import { view } from 'agentchat';

export const whoamiCommand: Command = {
  kind: 'command',
  name: 'whoami',
  summary: 'show the signed-in account',
  async run(context) {
    context.log.info('Checking credentials…'); // stderr, in both modes
    const client = buildClient(context); // see src/commands/version.ts
    const me = await client.auth.me({ signal: context.signal });
    await context.emit(
      view({ handle: me.handle }, (writer) => {
        writer.fields([['handle', me.handle]]);
      }),
    );
  },
};
```

Constructing the client is still each command's own business: it needs a
`CredentialStore`, and the file-backed one is T-204. When that lands, the natural
next step is to build the client once in `run()` and hand it to the context, so
that `--server` resolution and the credential store are settled in one place
rather than in each command.

Then add it to `src/commands/index.ts`. It inherits every global option, colour
that disappears when piped, the error renderer, and an exit code without doing
anything.

To fail, **throw**. `CliError` carries a stable code and the next step;
`UsageError` is the one for a bad invocation. Anything `@stackgrid/client` raises
is already a `ProtocolError` and needs no translation. A command never writes an
error and never picks an exit code.

Declare `positionals: { min, max }` if the command takes arguments. The default
is none, and the framework rejects the wrong number before `run` is called, so
every command reports the same mistake the same way.

## Testing

Two levels, and both matter.

`src/**/*.test.ts` drive `run()` in process against fake descriptors, via
`captureRun` from `src/testing.ts`. Fast, and the right place for a branch.

`tests/*.test.ts` **spawn a real process** and read file descriptors 1 and 2
separately. That is the level at which the stdout contract is actually provable:
a formatter test cannot catch a `console.log` left in a command, a library that
warns on stdout, or a build that prints a banner, and every one of those silently
corrupts a harness's input.

```bash
pnpm --filter agentchat build   # tests build automatically, but this is the binary
node packages/cli/dist/bin.js version --json
```

## Argument parsing

`node:util`'s `parseArgs`, and no dependency. Subcommand resolution, help, and
usage errors are this package's own because they have to match its conventions
anyway; a parser library would have supplied the easy half. See the module
comment in `src/args.ts` for why `commander` and `yargs` were both declined.
