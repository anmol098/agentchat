/**
 * One function decides which server a command talks to.
 *
 * Every other suite in this directory tests one command. This one tests the
 * *set* of them, because the property at stake is not something any single
 * command can have: it is that no command answers "which server?" for itself.
 * The project has already watched that go wrong. Three private copies of the
 * resolution existed at once, two of them disagreeing about whitespace, and the
 * third — in `./agent.ts` — consulting no built-in default and failing with a
 * different sentence than every other command, for the same missing
 * configuration (T-026, T-030). Nothing failed while they disagreed, because
 * each command's own tests only ever asked what that command did.
 *
 * So the assertions here are all of the same shape: run *every* command that
 * opens a socket against the same environment, and require the outcome to be
 * the one `../config.ts` produces for that environment — not merely a
 * reasonable one, and not merely the same as the last time this file ran. The
 * expected text is read from {@link noServerConfiguredText} and from
 * {@link requireServer} at run time, so a command that grows a private resolver
 * fails here even if it copies today's wording exactly, the moment the shared
 * wording moves.
 *
 * ## Why the table is checked against the registry
 *
 * The weakness of a table is that a new command can simply not be in it.
 * {@link INVOCATIONS} is therefore compared against `COMMANDS`, and a command
 * added to the registry and not to the table fails the first test in the file.
 * Adding it means classifying it: `requires` a server, only `reports` on one,
 * or reaches none. That is a decision worth making deliberately, which is the
 * point of making it impossible to skip.
 *
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transport, TransportRequest, TransportResponse } from '@agentchat/client';
import { InMemoryCredentialStore } from '@agentchat/client';
import {
  ConversationId,
  ErrorCode,
  errorEnvelope,
  MessageId,
  ProjectId,
} from '@agentchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandNode } from '../command.js';
import { noServerConfiguredText, requireServer, SERVER_ENV } from '../config.js';
import { captureRun } from '../testing.js';
import { createAckCommand } from './ack.js';
import { createAgentCommand } from './agent.js';
import { createAgentsCommand } from './agents.js';
import { createLoginCommand, createLogoutCommand, createWhoamiCommand } from './auth.js';
import { createConversationCommand } from './conversation.js';
import { createInboxCommand } from './inbox.js';
import { COMMANDS } from './index.js';
import { createListenCommand } from './listen.js';
import { createProjectCommand } from './project.js';
import { createSendCommand } from './send.js';
import { statusCommand } from './status.js';
import { versionCommand } from './version.js';

/** A server that resolves, so a run gets past resolution and no further. */
const SERVER = 'https://chat.example.test';

/** A configured value that is not a server address at all. */
const MALFORMED_SERVER = 'ftp://chat.example.test';

/** The project every fixture acts in, named through the environment. */
const PROJECT = ProjectId.generate();

/** The invite code `project join` parses before it reaches the network. */
const INVITE_CODE = 'ANET-7K4M-Q2P9';

/** The thread `conversation` parses before it reaches the network. */
const CONVERSATION = ConversationId.generate();

/** The message `ack` parses before it reaches the network. */
const MESSAGE = MessageId.generate();

/**
 * A transport that answers nothing and remembers everything.
 *
 * The commands here are driven only as far as their first request, so what the
 * server would have replied does not matter. That a request was attempted at
 * all does: it is how "resolution succeeded" is observed from outside.
 */
class RecordingTransport implements Transport {
  public readonly calls: TransportRequest[] = [];

  /** @inheritdoc */
  public request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    return Promise.resolve({
      status: 404,
      headers: {},
      body: errorEnvelope(ErrorCode.NOT_FOUND, `No stub for ${request.method} ${request.path}.`),
    });
  }
}

/** A store that is logged in, so `auth: 'required'` calls reach the transport. */
function signedIn(): InMemoryCredentialStore {
  return new InMemoryCredentialStore({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  });
}

/**
 * The whole registry, built against test seams.
 *
 * Mirrors `./index.ts` entry for entry, including order; the first test is what
 * keeps it mirroring.
 *
 * @param transport - The transport every command is given.
 * @returns The commands to dispatch to.
 */
function registryWith(transport: Transport): readonly CommandNode[] {
  const seams = { store: signedIn(), transport } as const;
  return [
    createLoginCommand(seams),
    createLogoutCommand(seams),
    createWhoamiCommand(seams),
    createProjectCommand(seams),
    createAgentCommand(seams),
    createAgentsCommand(seams),
    createSendCommand(seams),
    createInboxCommand(seams),
    createConversationCommand(seams),
    createAckCommand(seams),

    createListenCommand(seams),

    statusCommand,
    versionCommand,
  ];
}

/**
 * Every command a user can invoke, as a space-separated path.
 *
 * @param nodes - The registry, or a group's children.
 * @param prefix - The path of the enclosing group.
 * @returns One entry per leaf command, in registry order.
 */
function leafPaths(nodes: readonly CommandNode[], prefix = ''): readonly string[] {
  return nodes.flatMap((node) => {
    const path = prefix === '' ? node.name : `${prefix} ${node.name}`;
    return node.kind === 'group' ? leafPaths(node.children, path) : [path];
  });
}

/**
 * How much of a server a command needs.
 *
 * `requires` is the set this file is about: a command that cannot do its job
 * without an address, and must therefore fail identically when there is none.
 * `reports` is `status` alone, which asks the same question and prints the
 * answer instead of throwing — it must still say the same words. `local` never
 * opens a socket.
 */
type Reach = 'requires' | 'reports' | 'local';

/** One command, and an invocation of it that gets as far as resolution. */
interface Invocation {
  /** The command path, as {@link leafPaths} spells it. */
  readonly path: string;

  /** What it needs. */
  readonly reach: Reach;

  /** Arguments that are valid, so nothing else fails first. */
  readonly argv: readonly string[];
}

/**
 * Every command, classified, with an invocation that reaches resolution.
 *
 * The arguments are chosen so that argument validation — which happens first,
 * on purpose, so a typo costs no round trip — cannot be what fails. Where a
 * command would prompt, `--yes` answers it, because a prompt is not something
 * this file is testing.
 */
const INVOCATIONS: readonly Invocation[] = [
  { path: 'login', reach: 'requires', argv: ['login'] },
  { path: 'logout', reach: 'requires', argv: ['logout'] },
  { path: 'whoami', reach: 'requires', argv: ['whoami'] },
  { path: 'project list', reach: 'requires', argv: ['project', 'list'] },
  { path: 'project create', reach: 'requires', argv: ['project', 'create', 'Payments Platform'] },
  { path: 'project invite', reach: 'requires', argv: ['project', 'invite'] },
  { path: 'project join', reach: 'requires', argv: ['project', 'join', INVITE_CODE, '--yes'] },
  { path: 'project leave', reach: 'requires', argv: ['project', 'leave', '--yes'] },
  { path: 'project init', reach: 'requires', argv: ['project', 'init', 'payments'] },
  { path: 'project current', reach: 'local', argv: ['project', 'current'] },
  { path: 'agent list', reach: 'requires', argv: ['agent', 'list'] },
  { path: 'agent create', reach: 'requires', argv: ['agent', 'create', 'backend'] },
  { path: 'agent rename', reach: 'requires', argv: ['agent', 'rename', 'backend', 'frontend'] },
  { path: 'agent delete', reach: 'requires', argv: ['agent', 'delete', 'backend', '--yes'] },
  { path: 'agent use', reach: 'requires', argv: ['agent', 'use', 'backend'] },
  { path: 'agent join', reach: 'requires', argv: ['agent', 'join', 'backend'] },
  { path: 'agents', reach: 'requires', argv: ['agents'] },
  { path: 'send', reach: 'requires', argv: ['send', '@alice/backend', 'hello'] },
  { path: 'inbox', reach: 'requires', argv: ['inbox'] },
  // `conversation` takes no project and no agent — a `cnv_` identifier names
  // its own project — but it still cannot ask anybody without an address, so it
  // belongs in the same class as the rest and must fail with the same words.
  { path: 'conversation', reach: 'requires', argv: ['conversation', CONVERSATION] },
  { path: 'ack', reach: 'requires', argv: ['ack', MESSAGE] },

  // `--runtime` is required and is validated before anything is resolved, so
  // it has to be present here or the usage error would be what fails.
  { path: 'listen', reach: 'requires', argv: ['listen', '--runtime', 'claude-code'] },

  { path: 'status', reach: 'reports', argv: ['status'] },
  { path: 'version', reach: 'local', argv: ['version'] },
];

/** Every command that cannot act without an address. */
const NETWORKED = INVOCATIONS.filter((invocation) => invocation.reach === 'requires');

const temporaries: string[] = [];

/**
 * A throwaway configuration directory, containing no configuration at all.
 *
 * This is the fresh installation: nothing has been logged in, nothing has been
 * written, and `XDG_CONFIG_HOME` points at a directory with no server in it.
 *
 * @returns Its absolute path.
 */
async function temporaryHome(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agentchat-server-'));
  temporaries.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** What one invocation produced, and whether it reached the network. */
interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;

  /** How many requests were attempted. Zero means resolution refused. */
  readonly requests: number;

  /** The configuration directory it ran against, for the paths it names. */
  readonly home: string;
}

/** How to run one command. */
interface Run {
  /** The environment, merged over a fresh home and a project named by variable. */
  readonly env?: Readonly<Record<string, string | undefined>>;

  /** Arguments appended to the invocation's own. */
  readonly extra?: readonly string[];
}

/**
 * Runs one command through the whole framework.
 *
 * @param invocation - Which command, and how to invoke it.
 * @param options - The environment and any extra arguments.
 * @returns Both streams, the exit code, the request count, and the home used.
 */
async function runCommand(invocation: Invocation, options: Run = {}): Promise<Outcome> {
  const home = await temporaryHome();
  const transport = new RecordingTransport();
  const run = await captureRun([...invocation.argv, ...(options.extra ?? [])], {
    commands: registryWith(transport),
    env: { XDG_CONFIG_HOME: home, AGENTCHAT_PROJECT: PROJECT, ...options.env },
    cwd: home,
  });
  return { ...run, requests: transport.calls.length, home };
}

describe('the registry and the table agree', () => {
  it('classifies every command this build ships', () => {
    expect([...INVOCATIONS].map((invocation) => invocation.path).sort()).toEqual(
      [...leafPaths(COMMANDS)].sort(),
    );
  });

  it('drives the same registry the binary does', () => {
    expect(leafPaths(registryWith(new RecordingTransport()))).toEqual(leafPaths(COMMANDS));
  });
});

/**
 * One line per command, so a failure names every command that disagreed rather
 * than only the first.
 *
 * @param invocation - The command the line is about.
 * @param verdicts - What was found, in a fixed order.
 * @returns The line to compare.
 */
function line(invocation: Invocation, verdicts: readonly (string | number | boolean)[]): string {
  return `${invocation.path}: ${verdicts.map(String).join(', ')}`;
}

describe('every command that talks to a server', () => {
  it('tells a fresh installation the one thing there is to tell it', async () => {
    const found: string[] = [];
    for (const invocation of NETWORKED) {
      const outcome = await runCommand(invocation);
      // The words come from `../config.ts`, including the path the answer is
      // saved to, so this asserts sameness rather than a wording. A command
      // that resolved privately would fail here the moment the shared sentence
      // moved under it — which is how the copy in `./agent.ts` came to name
      // `--server` where every other command named the `login` that fixes it
      // for good.
      const { message, hint } = noServerConfiguredText({ XDG_CONFIG_HOME: outcome.home });
      found.push(
        line(invocation, [
          `exit ${String(outcome.code)}`,
          `${String(outcome.requests)} requests`,
          `says it: ${String(outcome.stderr.includes(message) && outcome.stderr.includes(hint))}`,
        ]),
      );
    }

    // Exit 2, nothing asked of a server that was never identified, and the one
    // message.
    expect(found).toEqual(
      NETWORKED.map((invocation) => line(invocation, ['exit 2', '0 requests', 'says it: true'])),
    );
  });

  it('reads the variable when the flag is present but empty', async () => {
    // The case the copies disagreed about, in the form that separates them: a
    // `--server` that is whitespace is not an instruction, so the walk must
    // continue to the variable rather than stopping at the flag or skipping
    // past the variable to the configuration file.
    const found: string[] = [];
    for (const invocation of NETWORKED) {
      const outcome = await runCommand(invocation, {
        env: { [SERVER_ENV]: SERVER },
        extra: ['--server', '   '],
      });
      const { message } = noServerConfiguredText({ XDG_CONFIG_HOME: outcome.home });
      found.push(
        line(invocation, [
          `refused: ${String(outcome.stderr.includes(message))}`,
          `reached the server: ${String(outcome.requests > 0)}`,
        ]),
      );
    }

    expect(found).toEqual(
      NETWORKED.map((invocation) =>
        line(invocation, ['refused: false', 'reached the server: true']),
      ),
    );
  });

  it('refuses a value that is not a server address in the same words', async () => {
    const shared = await requireServer({ env: { [SERVER_ENV]: MALFORMED_SERVER } }).then(
      () => '',
      (error: unknown) => (error as Error).message,
    );
    expect(shared).not.toBe('');

    const found: string[] = [];
    for (const invocation of NETWORKED) {
      const outcome = await runCommand(invocation, { env: { [SERVER_ENV]: MALFORMED_SERVER } });
      found.push(
        line(invocation, [
          `says it: ${String(outcome.stderr.includes(shared))}`,
          `${String(outcome.requests)} requests`,
        ]),
      );
    }

    expect(found).toEqual(
      NETWORKED.map((invocation) => line(invocation, ['says it: true', '0 requests'])),
    );
  });
});

describe('the command that only reports on a server', () => {
  it('says the same thing about a fresh installation as the ones that fail', async () => {
    const status = INVOCATIONS.find((invocation) => invocation.reach === 'reports');
    expect(status).toBeDefined();

    const outcome = await runCommand(status as Invocation);
    const said = `${outcome.stdout}${outcome.stderr}`;
    const { message, hint } = noServerConfiguredText({ XDG_CONFIG_HOME: outcome.home });

    expect(said).toContain(message);
    expect(said).toContain(hint);
  });
});
