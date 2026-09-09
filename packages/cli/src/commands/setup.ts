/**
 * `agentchat setup` — the four things a fresh installation needs, in order.
 *
 * Somebody who has just run the installer has no server address, no account, no
 * project and no agent, and every one of those is a separate command. This is
 * the shortest path through all four, because the number this task exists to
 * move is the time from `npm i -g agentchat` to a first received message, and
 * five commands typed from five different places in the documentation is where
 * that time goes.
 *
 * ## It composes the commands, it does not reimplement them
 *
 * Every step here runs the *real* command through its exported builder —
 * {@link createLoginCommand}, {@link createProjectCreateCommand} and the rest —
 * against a context this module builds. Nothing in this file makes an HTTP call
 * that a command already makes, and nothing here decides what a valid project
 * name or invite code is: {@link requireProjectName}, {@link requireInviteCode}
 * and {@link requireAgentName} do, which is how a mistyped answer is rejected
 * in the server's own words without a round trip.
 *
 * The alternative — a wizard that calls `client.projects.create` itself — is a
 * second implementation of six commands that would drift the first time one of
 * them grew a rule. This one cannot drift, because there is only ever one
 * implementation and the wizard is a caller of it.
 *
 * ## Why the sub-commands' results do not reach stdout
 *
 * A delegated command is handed an `emit` that keeps the view instead of
 * writing it. Six JSON records where a harness expected one would make
 * `agentchat setup --json` unparseable as a single answer, and PRD §39 gives
 * stdout to *the* result of the command that was run. So the wizard reports
 * progress on stderr as it goes and emits one summary at the end.
 *
 * ## Order, and the one ordering that is not a preference
 *
 * Login, then a project, then an agent, then the repository file. The first
 * three could in principle be argued about; the last cannot. `project init`
 * verifies membership before it writes (T-207), so it has to come after the
 * join, and it is deliberately the very last thing that happens — the committed
 * file is the artefact everybody who clones the repository resolves through,
 * and it should not be written by a run that then failed to give them an agent.
 *
 * ## Already satisfied, and what that means for each step
 *
 * Re-running has to be safe, because the commonest reason to run this command a
 * second time is that it stopped in the middle of the first. Each step decides
 * for itself whether there is anything to do:
 *
 * | Step       | Satisfied when                                                    |
 * | ---------- | ----------------------------------------------------------------- |
 * | login      | credentials are on this machine, a server resolves, and the server still accepts them |
 * | project    | a project resolves for this directory and the caller is a member of it |
 * | agent      | the caller has a default agent in that project, or exactly one agent in it |
 * | repository | `.agentchat/config.json` at or above the working directory names that project |
 *
 * The agent rule is the last two of the three that `./listen.ts` resolves
 * through `../context.ts`, restated as a question about durable state rather
 * than about one invocation: `--agent` and `AGENTCHAT_AGENT` are deliberately
 * *not* consulted, because a variable set for one shell is not a reason to
 * leave a machine without an agent of its own.
 *
 * ## Nothing here can be answered by a machine
 *
 * Four of the questions are genuinely unanswerable without a person: the
 * server's address, which project, what to call the agent, and — because
 * `--runtime` is required and `./listen.ts` refuses to guess it — which harness
 * this will run in. The device flow adds a fifth thing only a person can do,
 * which is approving the sign-in in a browser. So a non-interactive invocation
 * does not start: it prints the individual commands for the steps that are
 * still outstanding and exits 2. Fifteen minutes of a CI job spent waiting for
 * a browser approval that is never coming is the failure this prevents.
 *
 * @module
 */

import type { AgentChatClient, CredentialStore } from '@agentchat/client';
import type { AgentId, ProjectId, ProjectMembership } from '@agentchat/protocol';
import { ErrorCode, ProjectId as ProjectIdKind, ProtocolError } from '@agentchat/protocol';

import { Args, type OptionSpecs } from '../args.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext } from '../command.js';
import {
  defaultAgentFor,
  findRepositoryConfig,
  readUserConfig,
  repositoryConfigPath,
  requireServer,
  resolveServer,
  type SettledServer,
  serverRequestFor,
} from '../config.js';
import { contextRequestFor, resolveProject } from '../context.js';
import { createCredentialStore, credentialsPath } from '../credentials.js';
import { CliError, UsageError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { StreamSource } from '../output/streams.js';
import { PROGRAM } from '../version.js';
import type { AgentOverrides } from './agent.js';
import { createAgentCreateCommand, createAgentUseCommand, requireAgentName } from './agent.js';
import type { AuthOverrides } from './auth.js';
import { createLoginCommand } from './auth.js';
import { RUNTIME_ENV } from './listen.js';
import type { ProjectOverrides } from './project.js';
import {
  createProjectCreateCommand,
  createProjectInitCommand,
  createProjectJoinCommand,
  requireInviteCode,
  requireProjectName,
} from './project.js';

/**
 * The seams the whole wizard is built on.
 *
 * One set for all six delegated commands, because they are all being driven
 * against the same stubbed server in a test and against the same real one in
 * production. The union is exact rather than convenient: every field here is
 * declared by at least one of the three command modules, and passing the whole
 * object to each builder is what keeps them consistent.
 */
export interface SetupOverrides extends AuthOverrides, ProjectOverrides, AgentOverrides {}

/** `--runtime`, so a person who already knows it is asked one question fewer. */
const SETUP_OPTIONS: OptionSpecs = Object.freeze({
  runtime: {
    type: 'string',
    placeholder: '<name>',
    description: `the harness you will run \`${PROGRAM} listen\` in (also ${RUNTIME_ENV})`,
  },
});

/**
 * The steps, in the order they happen.
 *
 * `listen` is not a step the wizard performs — it is the command it ends by
 * printing — but it is in the list because it belongs in the sequence a
 * non-interactive run is told to type, and putting it anywhere else would mean
 * two orderings to keep in step with each other.
 */
const STEPS = ['login', 'project', 'agent', 'repository', 'listen'] as const;

/** One of {@link STEPS}. */
type StepName = (typeof STEPS)[number];

/** What happened to one step. */
type StepStatus = 'satisfied' | 'done';

/** One line of the summary: what the step was, and whether it had to act. */
interface StepReport {
  /** Which step. */
  readonly name: StepName;

  /** Whether it was already satisfied or was carried out now. */
  readonly status: StepStatus;

  /** One line for a human: what was found, or what was done. */
  readonly detail: string;
}

/** The project a run settled on, however it got there. */
interface ChosenProject {
  /** The project id, which is what the committed file records. */
  readonly id: ProjectId;

  /** Its slug, which is what a person reads and what `project init` is given. */
  readonly slug: string;
}

/**
 * What the wizard has learned, for the command list a refusal prints.
 *
 * Mutable and threaded through the run, because the value of a printed
 * `agentchat project init payments` over `agentchat project init <slug>` is
 * exactly that the reader can paste it.
 */
interface Facts {
  /** The server, once one is known. */
  server: string | null;

  /** The project, as `project init` would take it: its slug, or its id. */
  projectRef: string | null;

  /** The agent's name, once there is one. */
  agentName: string | null;

  /** The harness `listen` will declare. */
  runtime: string | null;
}

/** Everything one run of the wizard carries. */
interface Session {
  /** The command context this run was invoked with. */
  readonly context: CommandContext;

  /** The seams every delegated command is built against. */
  readonly overrides: SetupOverrides;

  /**
   * Standard input, opened once for the whole run.
   *
   * Once, and not once per question: {@link StreamSource.close} releases the
   * descriptor, and on a real `process.stdin` releasing it destroys the stream,
   * so a second source would read end of input and the wizard would decide
   * nobody was there. It is also why no delegated command is allowed to prompt
   * — see {@link joinProject}.
   */
  readonly input: StreamSource;

  /** Whether there is somebody to ask. See the module note. */
  readonly interactive: boolean;

  /** The step being attempted, for the command list a refusal prints. */
  stage: StepName;

  /** What is known so far, for the same list. */
  readonly facts: Facts;

  /** The steps that need no command, so a refusal does not list them. */
  readonly satisfied: Set<StepName>;

  /** What each step did, for the summary. */
  readonly reports: StepReport[];
}

/** How many times a question is asked again after an unusable answer. */
const MAX_ATTEMPTS = 3;

/**
 * The credential store this run reads and the delegated commands write.
 *
 * The same six lines as `./auth.ts` and `./project.ts` build, which T-036 is
 * filed to collapse into `../client.ts`; `clientFor` builds one privately and
 * does not hand it back, and this command needs the store itself to answer
 * "are there credentials on this machine at all" without a request.
 *
 * @param session - The run.
 * @returns The store.
 */
function storeFor(session: Session): CredentialStore {
  return (
    session.overrides.store ??
    createCredentialStore({
      path: credentialsPath(session.context.env.env),
      warn: (message: string): void => {
        session.context.log.warn(message);
      },
    })
  );
}

/**
 * The individual command for one step, filled in as far as it can be.
 *
 * @param step - The step.
 * @param facts - What the run knows.
 * @returns The command line, with a placeholder for anything still unknown.
 */
function commandFor(step: StepName, facts: Facts): string {
  switch (step) {
    case 'login':
      return `${PROGRAM} login --server ${facts.server ?? '<url>'}`;
    case 'project':
      return `${PROGRAM} project create <name>`;
    case 'agent':
      return `${PROGRAM} agent create <name>`;
    case 'repository':
      return `${PROGRAM} project init ${facts.projectRef ?? '<slug>'}`;
    case 'listen':
      return `${PROGRAM} listen --runtime ${facts.runtime ?? '<name>'}`;
  }
}

/**
 * The commands that would finish what this run cannot.
 *
 * Everything from the step that is blocked onwards, minus the steps already
 * found to be satisfied. A step *after* the blocked one may turn out to need
 * nothing either, but that cannot be known without doing the step in front of
 * it, and listing a command somebody does not need costs them one run of it
 * that says so.
 *
 * @param session - The run.
 * @returns One command per outstanding step, in the order to type them.
 */
function remainingCommands(session: Session): readonly string[] {
  const from = STEPS.indexOf(session.stage);
  return STEPS.slice(from < 0 ? 0 : from)
    .filter((step) => !session.satisfied.has(step))
    .map((step) => commandFor(step, session.facts));
}

/**
 * Stops, because there is a question and nobody to answer it.
 *
 * Exit 2 rather than 1: a usage error is the code for "retrying this unchanged
 * cannot help", and re-running a wizard in a pipeline will hit the same wall
 * every time. It is the same answer `project join --json` gives without
 * `--yes`, for the same reason.
 *
 * The list goes to stderr as a block in human mode and into the hint in JSON
 * mode. Not both: the block is unreadable inside an envelope field and the
 * envelope is the only thing a `--json` consumer reads, so each mode gets the
 * one form it can use.
 *
 * @param session - The run.
 * @param reason - Why there is nobody to ask.
 * @throws {UsageError} Always. The return type says so.
 */
function refuseToPrompt(session: Session, reason: string): never {
  const commands = remainingCommands(session);
  const alsoJoin = commands.some((command) => command.includes('project create'));
  const { context } = session;

  if (!context.isJson) {
    context.log.raw('');
    context.log.raw('These are the steps that are left. Run them in order:');
    context.log.raw('');
    for (const command of commands) {
      context.log.raw(`  ${command}`);
    }
    if (alsoJoin) {
      context.log.raw('');
      context.log.raw(
        `  (use \`${PROGRAM} project join <code>\` instead of \`project create\` if somebody sent you an invite code)`,
      );
    }
    context.log.raw('');
  }

  throw new UsageError(reason, {
    hint: context.isJson
      ? `Run these instead, in order: ${commands.map((command) => `\`${command}\``).join('; ')}.`
      : 'Run the commands above, in order. Each is one step of what this wizard would have done.',
  });
}

/**
 * Asks a question and reads one line.
 *
 * The prompt is {@link Logger.raw} rather than `info`, for the reason every
 * other prompt in this CLI is: `--quiet` must not suppress the one line the
 * command is waiting on an answer to.
 *
 * @param session - The run.
 * @param question - The question, ending in a colon or a question mark.
 * @returns The answer, trimmed.
 * @throws {UsageError} When standard input ends. End of input is nobody being
 *   there, which is the same situation as a pipeline and gets the same answer.
 */
async function ask(session: Session, question: string): Promise<string> {
  if (!session.interactive) {
    refuseToPrompt(session, notInteractive(session.context));
  }

  session.context.log.raw(`${question} `);
  const answer = await session.input.readLine(session.context.signal);
  if (answer === null) {
    refuseToPrompt(
      session,
      `Standard input ended before \`${PROGRAM} setup\` had an answer to “${question}”.`,
    );
  }
  return answer.trim();
}

/**
 * Why this invocation cannot ask anything.
 *
 * @param context - The command context.
 * @returns The sentence for the refusal.
 */
function notInteractive(context: CommandContext): string {
  return context.isJson
    ? `\`--json\` cannot answer the questions \`${PROGRAM} setup\` asks.`
    : `\`${PROGRAM} setup\` asks questions, and this is not an interactive terminal.`;
}

/**
 * Asks until the answer is one this command can use.
 *
 * The validators throw {@link UsageError} carrying the server's own explanation
 * of the rule, which is exactly the sentence somebody who typed a bad name
 * needs; catching it and asking again turns a fatal exit into a second attempt,
 * which is what a wizard is for. It gives up rather than looping for ever,
 * because a caller feeding a file to a terminal can otherwise never stop.
 *
 * @param session - The run.
 * @param question - The question.
 * @param accept - Validates and normalises the answer.
 * @returns The accepted value.
 * @throws {UsageError} The last rejection, once the attempts are used up.
 */
async function askFor<T>(
  session: Session,
  question: string,
  accept: (answer: string) => T,
): Promise<T> {
  let last: UsageError | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const answer = await ask(session, question);
    try {
      return accept(answer);
    } catch (error) {
      if (!(error instanceof UsageError)) {
        throw error;
      }
      last = error;
      session.context.log.raw(error.message);
      if (error.hint !== undefined) {
        session.context.log.raw(error.hint);
      }
    }
  }

  throw last ?? new UsageError(`No usable answer to “${question}”.`);
}

/** What one delegated command was invoked with. */
interface Invocation {
  /** Positional arguments, after the command path. */
  readonly positionals?: readonly string[];

  /** Options, as the parser would have produced them. */
  readonly options?: Readonly<Record<string, string | boolean>>;
}

/**
 * Runs one real command inside this one.
 *
 * The sub-context shares the logger, the environment and the interrupt signal,
 * so progress and `Ctrl-C` behave as they do when the command is run on its
 * own. It does not share stdout — see the module note — and it is never in JSON
 * mode: the wizard renders its own single result, and a delegated command
 * deciding it could not prompt because `--json` was given would be answering a
 * question about the wizard's output format with a refusal about input.
 *
 * @param session - The run.
 * @param command - The command to run.
 * @param invocation - Its arguments.
 * @returns Whatever the command emitted, or `null` if it emitted nothing.
 */
async function delegate(
  session: Session,
  command: Command,
  invocation: Invocation = {},
): Promise<View | null> {
  let captured: View | null = null;

  await command.run({
    emit: (value: View): Promise<void> => {
      captured = value;
      return Promise.resolve();
    },
    isJson: false,
    log: session.context.log,
    args: new Args(
      { ...invocation.options },
      invocation.positionals ?? [],
      session.context.env.env,
    ),
    env: session.context.env,
    signal: session.context.signal,
  });

  return captured;
}

/**
 * The project a delegated `project create` or `project join` reported.
 *
 * Both emit `{ project: { id, slug, … } }`, and reading it is cheaper and more
 * accurate than listing the projects again and guessing which one is new. The
 * shape is checked rather than asserted, so a view that changed underneath this
 * fails here with a sentence rather than somewhere later with `undefined`.
 *
 * @param emitted - What the command emitted.
 * @returns The project's id and slug.
 * @throws {CliError} `INTERNAL` when the command emitted nothing usable.
 */
function projectOf(emitted: View | null): ChosenProject {
  const json = emitted?.json;
  const project = isRecord(json) ? json['project'] : undefined;
  if (isRecord(project)) {
    const id = project['id'];
    const slug = project['slug'];
    if (ProjectIdKind.is(id) && typeof slug === 'string') {
      return { id, slug };
    }
  }

  throw new CliError(
    ErrorCode.INTERNAL,
    'The project was not reported back by the command that created or joined it.',
    {
      hint: `Run \`${PROGRAM} project list\` to see whether it exists, then \`${PROGRAM} setup\` again.`,
    },
  );
}

/**
 * Whether a JSON value is an object with named fields.
 *
 * @param value - The value.
 * @returns `true` for a JSON object.
 */
function isRecord(value: JsonValue | undefined): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Signs in, and answers with a client that has been proved to work.
 *
 * The proof is the project listing, which the next step needs anyway. That is
 * deliberate rather than incidental: credentials existing on disk is not the
 * same as credentials the server still accepts, and today it is a long way from
 * it — the device flow issues a refresh token that cannot be spent (T-043), so
 * an access token an hour old is simply dead. Somebody re-running this the next
 * morning has a credentials file and no working session, and a step that read
 * only the file would call that satisfied and fail on the next line.
 *
 * `GET /me` would be the obvious check and is not used, for the same reason: it
 * is one of the three routes T-043 is adding.
 *
 * @param session - The run.
 * @returns The server, a client, and the caller's memberships.
 */
async function signIn(session: Session): Promise<{
  readonly server: SettledServer;
  readonly client: AgentChatClient;
  readonly memberships: readonly ProjectMembership[];
}> {
  const { context } = session;
  session.stage = 'login';

  const resolved = await resolveServer(serverRequestFor(context));
  session.facts.server = resolved.url;

  const credentialled = (await storeFor(session).load()) !== null;
  if (resolved.url !== null && credentialled) {
    const server = await requireServer(serverRequestFor(context));
    const client = await clientFor(context, session.overrides);
    const listed = await listProjects(session, client);
    if (listed !== null) {
      session.satisfied.add('login');
      session.reports.push({
        name: 'login',
        status: 'satisfied',
        detail: `already signed in to ${server.url} (${resolved.origin ?? 'configured'})`,
      });
      return { server, client, memberships: listed };
    }
    context.log.info(`${server.url} no longer accepts the credentials on this machine.`);
  }

  const url =
    resolved.url ??
    (await askFor(
      session,
      `Which AgentChat server do you use? (for example ${EXAMPLE_SERVER})`,
      (answer) => requireServerAnswer(answer),
    ));
  session.facts.server = url;

  // `login` is what records the address (T-026); nothing here writes it, so a
  // typed URL that never completes a sign-in leaves no trace behind.
  await delegate(session, createLoginCommand(session.overrides), { options: { server: url } });

  const server = await requireServer({ env: context.env.env, serverFlag: url });
  const client = await clientFor(context, session.overrides);
  const memberships = await listProjects(session, client);
  if (memberships === null) {
    throw new CliError(ErrorCode.AUTH_REQUIRED, `${server.url} did not accept the sign-in.`, {
      hint: `Run \`${PROGRAM} login --server ${server.url}\` and check that it completes, then run \`${PROGRAM} setup\` again.`,
    });
  }

  session.reports.push({ name: 'login', status: 'done', detail: `signed in to ${server.url}` });
  session.facts.server = server.url;
  return { server, client, memberships };
}

/** The address shown as an example when asking for one. */
const EXAMPLE_SERVER = 'https://chat.example.com';

/**
 * Accepts a typed server address, or explains what one looks like.
 *
 * Only the shape a person can get wrong at the keyboard is checked here; the
 * rest — that it is absolute, that the scheme is `http` or `https` — is
 * {@link requireServer}'s, and it runs on this value moments later.
 *
 * @param answer - What was typed.
 * @returns The address, trimmed.
 * @throws {UsageError} When it is empty or plainly not a URL.
 */
function requireServerAnswer(answer: string): string {
  if (answer === '') {
    throw new UsageError('An AgentChat server address is needed to sign in.', {
      hint: `Ask whoever runs your server for its address, or use your own deployment's. For example ${EXAMPLE_SERVER}.`,
    });
  }
  if (!/^https?:\/\/\S+$/.test(answer)) {
    throw new UsageError(`\`${answer}\` is not an http or https URL.`, {
      hint: `It should look like ${EXAMPLE_SERVER}.`,
    });
  }
  return answer;
}

/**
 * The caller's memberships, or `null` when the server will not say.
 *
 * `null` means specifically "these credentials are not accepted"; every other
 * failure is somebody else's to report and is rethrown.
 *
 * @param session - The run.
 * @param client - The client to ask.
 * @returns The memberships, or `null`.
 */
async function listProjects(
  session: Session,
  client: AgentChatClient,
): Promise<readonly ProjectMembership[] | null> {
  try {
    const { items } = await client.projects.list({ signal: session.context.signal });
    return items;
  } catch (error) {
    if (error instanceof ProtocolError && error.code === ErrorCode.AUTH_REQUIRED) {
      return null;
    }
    throw error;
  }
}

/**
 * Finds or obtains the project this directory will belong to.
 *
 * @param session - The run.
 * @param client - The client.
 * @param memberships - The projects the caller is already in.
 * @returns The project.
 */
async function chooseProject(
  session: Session,
  client: AgentChatClient,
  memberships: readonly ProjectMembership[],
): Promise<ChosenProject> {
  session.stage = 'project';
  const existing = await alreadyResolvedProject(session, memberships);
  if (existing !== null) {
    session.satisfied.add('project');
    session.facts.projectRef = existing.slug;
    session.reports.push({
      name: 'project',
      status: 'satisfied',
      detail: `already in ${existing.slug}`,
    });
    return existing;
  }

  // Declining the invite preview is not a failure — `project join` treats it as
  // success for the same reason — but it does leave the wizard without the one
  // thing every later step needs, so the question comes round again rather than
  // ending a run that has nothing wrong with it.
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const chosen =
      memberships.length === 0
        ? await createOrJoin(session, client)
        : await pickFromList(session, client, memberships);
    if (chosen !== null) {
      session.facts.projectRef = chosen.slug;
      return chosen;
    }
  }

  throw new UsageError('No project was chosen, so there is nothing to set up.', {
    hint: `Run \`${PROGRAM} setup\` again with the invite code you meant, or create a project with \`${PROGRAM} project create <name>\`.`,
  });
}

/**
 * The project this directory already resolves to, if the caller is in it.
 *
 * A project that resolves and that the caller is *not* a member of is a
 * failure rather than a reason to choose another one. Something — a committed
 * file, a flag, a variable — has already said which project this directory is
 * for, and quietly setting up a different one would leave the working tree
 * pointing at two.
 *
 * @param session - The run.
 * @param memberships - The projects the caller is in.
 * @returns The project, or `null` when nothing resolves.
 * @throws {CliError} `NOT_FOUND` when something resolves and it is not one of
 *   the caller's.
 */
async function alreadyResolvedProject(
  session: Session,
  memberships: readonly ProjectMembership[],
): Promise<ChosenProject | null> {
  const resolved = await resolveProject(contextRequestFor(session.context)).catch(
    (error: unknown) => {
      if (error instanceof ProtocolError && error.code === ErrorCode.NO_PROJECT) {
        return null;
      }
      throw error;
    },
  );
  if (resolved === null) {
    return null;
  }

  const match = memberships.find((membership) =>
    resolved.id !== null ? membership.id === resolved.id : membership.slug === resolved.slug,
  );
  if (match !== undefined) {
    return { id: match.id, slug: match.slug };
  }

  throw new CliError(
    ErrorCode.NOT_FOUND,
    `${resolved.origin} names ${resolved.slug ?? resolved.id ?? 'a project'}, which is not a project you are in.`,
    {
      hint:
        `Ask a member for an invite code and run \`${PROGRAM} project join <code>\`. ` +
        `\`${PROGRAM} project list\` shows the projects you are in.`,
    },
  );
}

/**
 * The first-project question: make one, or redeem a code for one.
 *
 * @param session - The run.
 * @param client - The client.
 * @returns The project, or `null` when an invite preview was declined.
 */
async function createOrJoin(
  session: Session,
  client: AgentChatClient,
): Promise<ChosenProject | null> {
  session.context.log.raw('');
  session.context.log.raw('You are in no projects yet.');
  const answer = await askFor(
    session,
    'Create a project, or join one with an invite code? [create/join]',
    (typed) => requireChoice(typed, ['create', 'join']),
  );
  return answer === 'create' ? await createProject(session) : await joinProject(session, client);
}

/**
 * The same question when the caller is already in projects.
 *
 * One prompt rather than two, because "use payments" is the answer somebody
 * re-running this in a second repository almost always has, and making them
 * decline a create/join question first to reach it is a question asked for the
 * benefit of the code rather than the reader.
 *
 * @param session - The run.
 * @param client - The client.
 * @param memberships - The projects the caller is in.
 * @returns The project, or `null` when an invite preview was declined.
 */
async function pickFromList(
  session: Session,
  client: AgentChatClient,
  memberships: readonly ProjectMembership[],
): Promise<ChosenProject | null> {
  const { log } = session.context;
  log.raw('');
  log.raw('You are in these projects:');
  log.raw('');
  for (const [index, membership] of memberships.entries()) {
    log.raw(`  ${String(index + 1)}  ${membership.slug}  —  ${membership.name}`);
  }
  log.raw('');

  const answer = await askFor(
    session,
    'Use one by number, or type `create` for a new project, or `join` to redeem an invite code:',
    (typed) => requireSelection(typed, memberships.length),
  );

  if (answer === 'create') {
    return await createProject(session);
  }
  if (answer === 'join') {
    return await joinProject(session, client);
  }
  const membership = memberships[answer - 1];
  if (membership === undefined) {
    throw new CliError(ErrorCode.INTERNAL, 'The chosen project was out of range.');
  }
  return { id: membership.id, slug: membership.slug };
}

/**
 * Reads one of a fixed set of words.
 *
 * @param answer - What was typed.
 * @param options - The acceptable words, first-letter abbreviations included.
 * @returns The word.
 * @throws {UsageError} When it is neither.
 */
function requireChoice<T extends string>(answer: string, options: readonly T[]): T {
  const normalised = answer.toLowerCase();
  const match = options.find(
    (option) => option === normalised || option.slice(0, 1) === normalised,
  );
  if (match === undefined) {
    throw new UsageError(`\`${answer}\` is not one of ${options.join(' or ')}.`, {
      hint: `Type ${options.map((option) => `\`${option}\``).join(' or ')}.`,
    });
  }
  return match;
}

/**
 * Reads a menu answer: a number in range, or one of the two words.
 *
 * @param answer - What was typed.
 * @param count - How many numbered entries there are.
 * @returns The one-based index, or the word.
 * @throws {UsageError} When it is neither.
 */
function requireSelection(answer: string, count: number): number | 'create' | 'join' {
  const normalised = answer.toLowerCase();
  if (normalised === 'create' || normalised === 'c') {
    return 'create';
  }
  if (normalised === 'join' || normalised === 'j') {
    return 'join';
  }
  if (/^\d+$/.test(normalised)) {
    const index = Number(normalised);
    if (index >= 1 && index <= count) {
      return index;
    }
  }
  throw new UsageError(`\`${answer}\` is not one of the choices.`, {
    hint: `Type a number from 1 to ${String(count)}, or \`create\`, or \`join\`.`,
  });
}

/**
 * Creates a project.
 *
 * @param session - The run.
 * @returns The project.
 */
async function createProject(session: Session): Promise<ChosenProject> {
  const name = await askFor(session, 'What is the project called?', requireProjectName);
  const emitted = await delegate(session, createProjectCreateCommand(session.overrides), {
    positionals: [name],
    options: serverOption(session),
  });
  const project = projectOf(emitted);
  session.reports.push({
    name: 'project',
    status: 'done',
    detail: `created ${project.slug} (${project.id})`,
  });
  return project;
}

/**
 * Redeems an invite code.
 *
 * The preview is shown here rather than left to `project join`, and `--yes` is
 * passed. Not to skip the confirmation — the confirmation happens, one prompt
 * earlier — but because `project join`'s prompt opens a second reader on
 * standard input and closing it would take the descriptor away from every
 * question after this one. The words are the ones PRD §27 asks for either way:
 * a code arrives over chat from somebody, and being shown whose project it
 * opens before answering is the only chance to notice it is not the one you
 * were expecting.
 *
 * @param session - The run.
 * @param client - The client, for the preview.
 * @returns The project, or `null` when the preview was declined.
 */
async function joinProject(
  session: Session,
  client: AgentChatClient,
): Promise<ChosenProject | null> {
  const { context } = session;
  const code = await askFor(session, 'Paste the invite code:', requireInviteCode);
  const preview = await client.invites.preview(code, { signal: context.signal });

  context.log.raw('');
  context.log.raw(`Project: ${preview.project.name} (${preview.project.slug})`);
  context.log.raw(`Invited by: ${preview.invitedBy.displayName} (@${preview.invitedBy.username})`);
  context.log.raw('');

  const confirmed = await askFor(session, `Join ${preview.project.name}? [yes/no]`, (typed) =>
    requireChoice(typed === '' ? 'yes' : typed, ['yes', 'no']),
  );
  if (confirmed === 'no') {
    context.log.raw(`Cancelled. You did not join ${preview.project.name}.`);
    return null;
  }

  const emitted = await delegate(session, createProjectJoinCommand(session.overrides), {
    positionals: [code],
    options: { ...serverOption(session), yes: true },
  });
  const project = projectOf(emitted);
  session.reports.push({
    name: 'project',
    status: 'done',
    detail: `joined ${project.slug} (${project.id})`,
  });
  return project;
}

/**
 * Makes sure the caller has an agent `listen` will resolve in this project.
 *
 * @param session - The run.
 * @param client - The client.
 * @param project - The project.
 * @returns The agent's name.
 */
async function chooseAgent(
  session: Session,
  client: AgentChatClient,
  project: ChosenProject,
): Promise<string> {
  session.stage = 'agent';
  const mine = await ownAgentsIn(session, client, project.id);
  const stored = defaultAgentFor(await readUserConfig(session.context.env.env), project.id);

  const byDefault = stored === null ? undefined : mine.find((agent) => agent.id === stored);
  const only = mine.length === 1 ? mine[0] : undefined;
  const settled = byDefault ?? only;
  if (settled !== undefined) {
    session.satisfied.add('agent');
    session.facts.agentName = settled.name;
    session.reports.push({
      name: 'agent',
      status: 'satisfied',
      detail:
        byDefault === undefined
          ? `${settled.name} is your only agent in ${project.slug}`
          : `${settled.name} is already your agent for ${project.slug}`,
    });
    return settled.name;
  }

  if (mine.length > 1) {
    // Several agents and no default is the one state `listen` cannot resolve on
    // its own, and `agent use` is the command that fixes it for good.
    const names = mine.map((agent) => agent.name);
    session.context.log.raw('');
    session.context.log.raw(`Your agents in ${project.slug}: ${names.join(', ')}.`);
    const chosen = await askFor(session, 'Which one should this directory speak as?', (typed) => {
      const name = requireAgentName(typed);
      if (!names.includes(name)) {
        throw new UsageError(`\`${name}\` is not one of your agents in ${project.slug}.`, {
          hint: `Type one of: ${names.join(', ')}.`,
        });
      }
      return name;
    });
    await delegate(session, createAgentUseCommand(session.overrides), {
      positionals: [chosen],
      options: { ...serverOption(session), project: project.id },
    });
    session.facts.agentName = chosen;
    session.reports.push({
      name: 'agent',
      status: 'done',
      detail: `${chosen} is now your agent for ${project.slug}`,
    });
    return chosen;
  }

  const name = await askFor(session, 'What should this agent be called?', (typed) =>
    requireAgentName(typed),
  );
  await delegate(session, createAgentCreateCommand(session.overrides), {
    positionals: [name],
    options: { ...serverOption(session), project: project.id },
  });
  session.facts.agentName = name;
  session.reports.push({
    name: 'agent',
    status: 'done',
    detail: `created ${name} in ${project.slug}`,
  });
  return name;
}

/**
 * The caller's own agents that are in a project.
 *
 * Two listings, because `GET /projects/:id/agents` is discovery and answers
 * with everybody's, while `GET /agents` is the only listing that answers for
 * the caller. An agent id is unique across owners, so intersecting on it is
 * enough.
 *
 * @param session - The run.
 * @param client - The client.
 * @param projectId - The project.
 * @returns The caller's agents in it, in the order the project lists them.
 */
async function ownAgentsIn(
  session: Session,
  client: AgentChatClient,
  projectId: ProjectId,
): Promise<readonly { readonly id: AgentId; readonly name: string }[]> {
  const { signal } = session.context;
  const [mine, here] = await Promise.all([
    client.agents.list({ signal }),
    client.projects.listAgents(projectId, { signal }),
  ]);
  const owned = new Set(mine.items.map((agent) => agent.id));
  return here.items
    .filter((row) => owned.has(row.agent.id))
    .map((row) => ({ id: row.agent.id, name: row.agent.name }));
}

/**
 * Writes the committed file, unless it is already there and already right.
 *
 * Last, and after the agent, on purpose: see the module note.
 *
 * @param session - The run.
 * @param project - The project the file will name.
 * @returns The absolute path of the file.
 */
async function linkDirectory(session: Session, project: ChosenProject): Promise<string> {
  session.stage = 'repository';
  const { cwd } = session.context.env;

  // A file that cannot be read is not "already linked"; `project init` is the
  // command that replaces it and explains what `--force` would do, and it says
  // that better than a wizard repeating it would.
  const discovered = await findRepositoryConfig(cwd).catch((error: unknown) => {
    if (error instanceof ProtocolError && error.code === ErrorCode.NO_PROJECT) {
      return null;
    }
    throw error;
  });

  if (discovered !== null && discovered.config.projectId === project.id) {
    session.satisfied.add('repository');
    session.reports.push({
      name: 'repository',
      status: 'satisfied',
      detail: `${discovered.path} already links this directory to ${project.slug}`,
    });
    return discovered.path;
  }

  await delegate(session, createProjectInitCommand(session.overrides), {
    positionals: [project.slug],
    options: serverOption(session),
  });
  const path = repositoryConfigPath(cwd);
  session.reports.push({
    name: 'repository',
    status: 'done',
    detail: `wrote ${path}`,
  });
  return path;
}

/**
 * The harness the printed `listen` command will declare.
 *
 * Asked rather than guessed, because `./listen.ts` refuses to guess it and says
 * why: the runtime is shown to everybody in the project by `agentchat agents`,
 * and a guessed one is indistinguishable from a true one. An unanswered
 * question here is deliberately not fatal — everything the wizard exists for
 * has already happened by the time it is asked — so it degrades to a
 * placeholder in the printed command rather than failing a run that worked.
 *
 * @param session - The run.
 * @returns The runtime, or `null` when nobody said.
 */
async function askRuntime(session: Session): Promise<string | null> {
  const given = session.context.args.value('runtime') ?? session.context.env.env[RUNTIME_ENV];
  const supplied = given?.trim() ?? '';
  if (supplied !== '') {
    return supplied;
  }
  if (!session.interactive) {
    return null;
  }

  session.context.log.raw('');
  session.context.log.raw(
    'Which harness will you run this in? (claude-code, codex, opencode, anything) ',
  );
  const answer = await session.input.readLine(session.context.signal);
  const runtime = answer?.trim() ?? '';
  return runtime === '' ? null : runtime;
}

/** What the wizard ended up with. */
interface Outcome {
  /** The server everything was done against. */
  readonly server: string;

  /** The project this directory now belongs to. */
  readonly project: ChosenProject;

  /** The agent this directory speaks as. */
  readonly agent: string;

  /** The committed file. */
  readonly configPath: string;

  /** The harness, or `null` when nobody named one. */
  readonly runtime: string | null;

  /** What each step did. */
  readonly steps: readonly StepReport[];
}

/**
 * The command to run next, exactly as it should be typed.
 *
 * @param runtime - The harness, or `null`.
 * @returns The command line.
 */
function listenCommand(runtime: string | null): string {
  return `${PROGRAM} listen --runtime ${runtime ?? '<name>'}`;
}

/**
 * The wizard's one result.
 *
 * @param outcome - What it ended up with.
 * @returns The view.
 */
export function setupView(outcome: Outcome): View {
  const next = listenCommand(outcome.runtime);
  const json: JsonValue = {
    server: outcome.server,
    project: { id: outcome.project.id, slug: outcome.project.slug },
    agent: { name: outcome.agent },
    repositoryConfig: outcome.configPath,
    steps: outcome.steps.map((step) => ({
      name: step.name,
      status: step.status,
      detail: step.detail,
    })),
    next: { command: next, runtime: outcome.runtime },
  };

  return view(json, (writer) => {
    writer.line(`${writer.style.bold('Set up.')} You can receive messages here.`);
    writer.blank();
    writer.fields([
      ['server', outcome.server],
      ['project', `${outcome.project.slug} (${outcome.project.id})`],
      ['agent', outcome.agent],
      ['config', outcome.configPath],
    ]);
    writer.blank();
    writer.line('Run this next:');
    writer.blank();
    writer.line(`  ${writer.style.cyan(next)}`);
    if (outcome.runtime === null) {
      writer.blank();
      writer.line(
        writer.style.dim(
          '`--runtime` names the harness you are running in — claude-code, codex, opencode, anything. It is shown to everyone in the project, so nothing guesses it.',
        ),
      );
    }
  });
}

/**
 * `--server`, forwarded to every delegated command.
 *
 * Passed explicitly rather than left to each command's own resolution so that
 * one wizard run cannot straddle two servers: `login` writes the address to the
 * user configuration part-way through, and a step that resolved afresh either
 * side of that write would be reading a different answer.
 *
 * @param session - The run.
 * @returns The option, or nothing when no server is known yet.
 */
function serverOption(session: Session): Readonly<Record<string, string>> {
  return session.facts.server === null ? {} : { server: session.facts.server };
}

/**
 * Runs the wizard.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 */
async function setup(context: CommandContext, overrides: SetupOverrides): Promise<void> {
  const session: Session = {
    context,
    overrides,
    input: new StreamSource(context.env.stdin),
    // Prompts are written to stderr and answered on stdin. stderr is the
    // descriptor that can say whether it is a terminal, and `--json` is a
    // caller saying there is a program on the other end of this rather than a
    // person, which is the same answer for the same reason.
    interactive: !context.isJson && context.env.stderr.isTTY === true,
    stage: 'login',
    facts: { server: null, projectRef: null, agentName: null, runtime: null },
    satisfied: new Set<StepName>(),
    reports: [],
  };

  try {
    if (session.interactive) {
      context.log.raw(`Welcome to ${PROGRAM}.`);
    }

    const { server, client, memberships } = await signIn(session);
    const project = await chooseProject(session, client, memberships);
    const agent = await chooseAgent(session, client, project);
    const configPath = await linkDirectory(session, project);

    session.stage = 'listen';
    const runtime = await askRuntime(session);
    session.facts.runtime = runtime;

    await context.emit(
      setupView({
        server: server.url,
        project,
        agent,
        configPath,
        runtime,
        steps: session.reports,
      }),
    );
  } finally {
    await session.input.close();
  }
}

/**
 * Builds `agentchat setup`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createSetupCommand(overrides: SetupOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'setup',
    summary: 'sign in, choose a project, make an agent, and link this directory',
    usage: 'setup [--server <url>] [--runtime <name>]',
    options: SETUP_OPTIONS,
    details: [
      'Walks through the four things a fresh installation needs: signing in, creating or joining a project, creating an agent, and writing `.agentchat/config.json` here.',
      'Every step is skipped when it is already satisfied, so running it again after an interruption picks up where it stopped rather than starting over.',
      'It asks questions, so it needs a terminal. Without one — in a pipeline, or under --json — it prints the individual commands for the steps that are outstanding and exits 2 rather than waiting for an answer that is not coming.',
      'It finishes by printing the `agentchat listen` command to run next.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return setup(context, overrides);
    },
  };
}

/** `agentchat setup`. */
export const setupCommand: Command = createSetupCommand();
