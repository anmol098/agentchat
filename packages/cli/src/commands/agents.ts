/**
 * `agentchat agents` — who else is in this project, and can they hear you right
 * now (plan §6.2, PRD §21, §36, §43).
 *
 * This is the command an AI coding agent runs before it addresses somebody it
 * has never addressed before. Everything else in this file follows from that
 * one sentence: the `--json` shape is the contract, the human rendering is the
 * courtesy, and the two are allowed to be shaped differently because they have
 * different readers.
 *
 * ## `agents` is not `agent`
 *
 * These two are one letter apart and mean opposite things, so the difference is
 * stated everywhere a user can encounter it rather than left to be inferred:
 *
 * | command             | scope                     | answers                    |
 * | ------------------- | ------------------------- | -------------------------- |
 * | `agentchat agent …` | the agents **you own**    | create, rename, delete, use |
 * | `agentchat agents`  | **everyone's** agents here | who can I talk to?          |
 *
 * Three things keep the pair from reading as a typo of each other:
 *
 * 1. **Dispatch cannot confuse them.** `Registry.resolve` matches names
 *    exactly — there is no prefix matching and no abbreviation — so `agents`
 *    never reaches the `agent` group and vice versa. The collision is a reading
 *    problem, not a routing one.
 * 2. **The summaries contrast rather than echo.** The group says "the agents you
 *    own"; this says "everyone's". Help lists them adjacently, which is the
 *    point: seen side by side the pair explains itself, where seen apart either
 *    one looks like the only agent command there is.
 * 3. **Typing one and meaning the other is caught.** `agentchat agents list` is
 *    the mistake this pair invites, and the framework's arity check would answer
 *    it with `Unexpected argument \`list\``, which is true and useless. So this
 *    command accepts stray positionals in order to reject them itself, naming
 *    `agentchat agent list` when the stray word is one of that group's
 *    subcommands. See {@link rejectSubcommand}.
 *
 * ## What `--json` promises
 *
 * ```json
 * {
 *   "project": { "id": "prj_…", "slug": "payments", "name": "Payments Platform" },
 *   "items": [
 *     {
 *       "address": "@alice/backend",
 *       "agent": { "id": "agt_…", "userId": "usr_…", "name": "backend", "createdAt": "…", "updatedAt": "…" },
 *       "owner": { "id": "usr_…", "username": "alice", "displayName": "Alice Example" },
 *       "online": true,
 *       "sessions": 2
 *     }
 *   ]
 * }
 * ```
 *
 * Three deliberate choices, because this document is a public interface:
 *
 * **It is flat, and it is `items`.** The human output groups by owner; the JSON
 * does not. A program reading this wants an address to send to and a boolean
 * saying whether anyone is listening, and a grouping level is one more walk
 * between it and both. Grouping is a one-liner on the consumer's side
 * (`Object.groupBy(items, (item) => item.owner.id)`) and un-grouping is not, so
 * the flat form is the one that loses nothing. `items` rather than a bare array
 * for the reason D17 gives — there is somewhere to put a cursor the day the
 * server sends one — and because every other listing this CLI emits is already
 * `{ items: [...] }`.
 *
 * **Each row is the wire row, verbatim, plus `address`.** `agent`, `owner`,
 * `online` and `sessions` are `ProjectAgentSchema`'s own fields, copied through
 * without reshaping, so this output cannot drift away from the protocol that
 * defines it. `address` is the one addition: `@alice/backend` is what
 * `agentchat send` takes, and a consumer that has to build it from `owner`
 * and `agent` is a consumer that can build it wrong.
 *
 * **`sessions` is always there, next to `online`.** T-401 settled that
 * `online === (sessions > 0)`, so the count looks redundant — and it is exactly
 * the number that tells somebody the listener they thought they killed is still
 * running, on a machine they have forgotten about. Two of them is a fact
 * `online: true` cannot express.
 *
 * ## Order comes from the server
 *
 * The listing is emitted in the order it arrived. The server orders by username
 * and then agent name, which is total and stable, so two runs against unchanged
 * data produce byte-identical JSON. Sorting again here could only *disagree*
 * with that — a client and a server with two different ideas of order is a
 * difference that shows up as flapping output — so nothing here sorts.
 *
 * Grouping preserves it: owners appear in the order their first agent does, and
 * agents within an owner keep their server order.
 *
 * ## Grouping is by owner id, never by username or agent name
 *
 * T-401's finding, followed rather than re-derived. A name is an address, not an
 * identity: deleting an agent frees its name and re-creating it mints a *new*
 * identifier (D13), so `@alice/backend` today and `@alice/backend` last week may
 * be two different participants. `owner.id` is the only key here that a rename
 * or a delete-and-recreate cannot move.
 *
 * Usernames happen to be unique, so grouping by one would work today. It would
 * also be a second identity rule sitting next to the real one, waiting for the
 * day usernames become mutable — and it is not less code.
 *
 * @module
 */

import type { ProjectAgent, ProjectId, ProjectMembership } from '@stackgrid/protocol';

import type { OptionSpecs } from '../args.js';
import type { ClientSeams } from '../client.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext } from '../command.js';
import { CONTEXT_OPTIONS, contextRequestFor, membershipFor, resolveProject } from '../context.js';
import { UsageError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { visibleWidth } from '../output/writer.js';
import { PROGRAM } from '../version.js';

/**
 * The seams this command is built on.
 *
 * Both have real defaults; they exist so a test can drive the whole command —
 * parsing, project resolution, both streams, the exit code — against a stubbed
 * server without a socket or a home directory. They are {@link ClientSeams}
 * rather than a restatement of it, so a seam added there reaches this command
 * without anyone remembering to copy it across.
 */
export type AgentsOverrides = ClientSeams;

/**
 * `--project`, and deliberately not `--agent`.
 *
 * Discovery is a property of the project, not of whoever is asking: the answer
 * is the same whichever of your agents you would have sent from. A `--agent`
 * flag here would parse, do nothing, and still be promised by `--help`.
 *
 * Derived from {@link CONTEXT_OPTIONS} rather than restated, so the description
 * and the environment variable it names stay in one place.
 */
const PROJECT_OPTIONS: OptionSpecs = Object.freeze(
  Object.fromEntries(Object.entries(CONTEXT_OPTIONS).filter(([name]) => name === 'project')),
);

/** The `agent` subcommands, for the "you meant the other one" message. */
const AGENT_SUBCOMMANDS: readonly string[] = Object.freeze([
  'list',
  'create',
  'rename',
  'delete',
  'use',
  'join',
]);

/**
 * How an agent is addressed: `@alice/backend` (PRD §16).
 *
 * @param row - One discovery row.
 * @returns The address `agentchat send` accepts.
 */
export function addressOf(row: ProjectAgent): string {
  return `@${row.owner.username}/${row.agent.name}`;
}

/** One owner and the agents they have in this project, in server order. */
export interface OwnerGroup {
  /** The owner. Grouped on `owner.id`; see the module note. */
  readonly owner: ProjectAgent['owner'];

  /** Their agents here, in the order the server listed them. */
  readonly agents: readonly ProjectAgent[];
}

/**
 * Groups a discovery listing by owner, without reordering it.
 *
 * Keyed on `owner.id` — never the username, never an agent name (D13). Order is
 * the server's: an owner's group appears where their first agent did, and their
 * agents keep the order they arrived in. Nothing here sorts, so this cannot
 * disagree with the ordering the server already guarantees.
 *
 * @param rows - The listing, exactly as the server sent it.
 * @returns One group per distinct owner, in first-appearance order.
 */
export function groupByOwner(rows: readonly ProjectAgent[]): readonly OwnerGroup[] {
  const groups = new Map<string, { owner: ProjectAgent['owner']; agents: ProjectAgent[] }>();

  for (const row of rows) {
    // A `Map` preserves insertion order, which is what keeps the server's
    // ordering intact through the grouping without anything being sorted.
    const existing = groups.get(row.owner.id);
    if (existing === undefined) {
      groups.set(row.owner.id, { owner: row.owner, agents: [row] });
    } else {
      existing.agents.push(row);
    }
  }

  return [...groups.values()];
}

/**
 * The presence half of one line: `online`, and the count behind it.
 *
 * The count is printed for every online agent rather than only for the
 * surprising ones. "online" alone means "one session" only to a reader who
 * already knows the invariant, and the reader who most needs this line is the
 * one who does not — the person wondering why an agent they shut down still
 * answers.
 *
 * @param row - One discovery row.
 * @returns The status word and the count beside it, already pluralised. The
 *   count is empty for an offline agent, which has no sessions by definition.
 */
export function presenceOf(row: ProjectAgent): { status: string; sessions: string } {
  if (!row.online) {
    return { status: 'offline', sessions: '' };
  }
  return {
    status: 'online',
    sessions: `${String(row.sessions)} session${row.sessions === 1 ? '' : 's'}`,
  };
}

/**
 * `agentchat agents`, in both representations.
 *
 * The human form is PRD §21's: a project heading, then a block per owner, then
 * one indented line per agent carrying its address and its presence. Two
 * departures from the example there, both additions:
 *
 * - The owner heading carries the username as well as the display name. Display
 *   names are decoration and need not be unique (PRD §3.4); two people called
 *   "Alex" would otherwise produce two adjacent, identical headings over
 *   different sets of agents, which is the exact confusion grouping by id
 *   exists to prevent, reintroduced at the last step.
 * - Every online agent shows its session count. See {@link presenceOf}.
 *
 * Addresses are aligned across the whole listing rather than within each owner's
 * block, so the status column is one column and not one per group.
 *
 * @param project - The project being discovered, for the heading and the JSON.
 * @param rows - The listing, in server order.
 * @returns The view.
 */
export function agentsView(project: ProjectMembership, rows: readonly ProjectAgent[]): View {
  const json: JsonValue = {
    project: { id: project.id, slug: project.slug, name: project.name },
    items: rows.map((row) => ({
      address: addressOf(row),
      agent: {
        id: row.agent.id,
        userId: row.agent.userId,
        name: row.agent.name,
        createdAt: row.agent.createdAt,
        updatedAt: row.agent.updatedAt,
      },
      owner: {
        id: row.owner.id,
        username: row.owner.username,
        displayName: row.owner.displayName,
      },
      online: row.online,
      sessions: row.sessions,
    })),
  };

  return view(json, (writer) => {
    writer.line(`${writer.style.dim('PROJECT:')} ${writer.style.bold(project.name)}`);

    if (rows.length === 0) {
      writer.blank();
      writer.line(`No agents are in ${project.name}.`);
      writer.line(
        writer.style.dim(
          `Add one of yours with \`${PROGRAM} agent create <name>\`, or invite somebody with \`${PROGRAM} project invite\`.`,
        ),
      );
      return;
    }

    const addressWidth = rows.reduce(
      (widest, row) => Math.max(widest, visibleWidth(addressOf(row))),
      0,
    );
    const statusWidth = visibleWidth('offline');

    for (const group of groupByOwner(rows)) {
      writer.blank();
      writer.line(
        `${writer.style.bold(group.owner.displayName)} ${writer.style.dim(`(@${group.owner.username})`)}`,
      );
      for (const row of group.agents) {
        const address = addressOf(row);
        const { status, sessions } = presenceOf(row);
        const presence = row.online ? writer.style.green(status) : writer.style.dim(status);
        const padding = ' '.repeat(Math.max(0, addressWidth - visibleWidth(address)));
        // Nothing is styled when there is nothing to style: `dim('')` is two
        // escape sequences around no text, which is invisible on a terminal and
        // very visible in a test that reads the bytes.
        const count =
          sessions === ''
            ? ''
            : `${' '.repeat(Math.max(0, statusWidth - status.length) + 2)}${writer.style.dim(sessions)}`;
        writer.line(`  ${writer.style.cyan(address)}${padding}  ${presence}${count}`);
      }
    }

    // The handoff this command exists for. A real address rather than a
    // placeholder, preferring one that is listening, because the failure this
    // saves is sending to an agent nobody is running.
    const reachable = rows.find((row) => row.online) ?? rows[0];
    writer.blank();
    writer.line(
      writer.style.dim(
        `Send to one with \`${PROGRAM} send ${reachable === undefined ? '<@user/agent>' : addressOf(reachable)} "…"\`.`,
      ),
    );
  });
}

/**
 * Rejects a stray word, in the terms of the mistake that produced it.
 *
 * `agentchat agents` takes no arguments, so the framework's arity check would
 * handle this — with `Unexpected argument \`list\``, which describes the symptom
 * of the one mistake this command's name invites and not the cause. A user who
 * typed `agentchat agents list` meant `agentchat agent list`, and being told so
 * is the difference between a correction and a puzzle.
 *
 * This is why the command declares unlimited positionals: it is not that it
 * accepts them, it is that it wants to be the one to refuse them.
 *
 * @param context - The command context.
 * @throws {UsageError} Exit 2 — the same code and shape the framework's own
 *   arity failure carries — whenever anything was passed.
 */
function rejectSubcommand(context: CommandContext): void {
  const stray = context.args.positionals[0];
  if (stray === undefined) {
    return;
  }

  const meantTheOtherOne = AGENT_SUBCOMMANDS.includes(stray);
  throw new UsageError(`\`${PROGRAM} agents\` takes no arguments; got \`${stray}\`.`, {
    hint: meantTheOtherOne
      ? `\`${PROGRAM} agents\` lists everyone's agents in the project. You may have meant \`${PROGRAM} agent ${stray}\`, which acts on the agents you own.`
      : `Usage: ${PROGRAM} agents [--project <slug|id>] [--json]`,
  });
}

/**
 * Runs `agentchat agents`.
 *
 * Two round trips: the project listing, which resolves a slug and supplies the
 * name for the heading, and the discovery listing itself. The second is one
 * request for the whole project, never one per agent — T-401 verified that on
 * the server side and this command must not undo it.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the listing has been written.
 */
async function discoverAgents(context: CommandContext, overrides: AgentsOverrides): Promise<void> {
  rejectSubcommand(context);

  const client = await clientFor(context, overrides);
  const resolved = await resolveProject(contextRequestFor(context));
  const membership = await membershipFor(client, resolved, context.signal);
  const projectId: ProjectId = membership.id;

  const { items } = await client.projects.listAgents(projectId, { signal: context.signal });

  await context.emit(agentsView(membership, items));
}

/**
 * Builds `agentchat agents`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createAgentsCommand(overrides: AgentsOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'agents',
    summary: "discover everyone's agents in a project, and who is reachable",
    usage: 'agents [--project <slug|id>] [--json]',
    options: PROJECT_OPTIONS,

    // Not because any are accepted. See `rejectSubcommand`.
    positionals: { min: 0, max: 'many' },
    details: [
      'Grouped by owner. Each line is the address `agentchat send` takes, whether anyone is listening on it, and how many sessions are behind that.',
      "This is the plural, project-wide command. `agentchat agent` is the singular one, and manages the agents you own rather than showing you everyone else's.",
      "`--json` emits a flat `items` array in the server's own order, each entry carrying `address`, `agent`, `owner`, `online` and `sessions`.",
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return discoverAgents(context, overrides);
    },
  };
}

/** `agentchat agents`. */
export const agentsCommand: Command = createAgentsCommand();
