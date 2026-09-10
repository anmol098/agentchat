/**
 * `agentchat inbox` — what is waiting for me, without holding a connection
 * open (plan §6.2, PRD §36).
 *
 * ```text
 * agentchat inbox
 * agentchat inbox --json | jq -r '.items[].messageId'
 * agentchat inbox --all            # the historical listing; see below
 * ```
 *
 * This command and `agentchat listen` answer the same question by opposite
 * means. `listen` holds a socket and is told; `inbox` asks. An agent harness
 * that cannot keep a process alive between turns — which is most of them —
 * polls this, acknowledges with `agentchat ack`, and never opens a WebSocket at
 * all. So the audience here is a program first and a person second, and the
 * decisions below all follow from that.
 *
 * ## The listed message shape, and how it differs from the streamed one
 *
 * {@link messageJson} is the one rendering of a message this command and
 * `agentchat conversation` share. It is **not** the shape `agentchat listen`
 * streams; the two overlap in nine field names and differ in three ways, all of
 * them set out in the table in `docs/cli.md`:
 *
 * ```json
 * {
 *   "messageId": "msg_…",
 *   "projectId": "prj_…",
 *   "conversationId": "cnv_…",
 *   "parentMessageId": null,
 *   "senderAgentId": "agt_…",
 *   "recipientAgentId": "agt_…",
 *   "sender": "@bob/backend",
 *   "recipient": "@you/backend",
 *   "content": "…",
 *   "createdAt": "2026-09-09T12:00:00.000Z"
 * }
 * ```
 *
 * The seven identifier and content fields are PRD §40's listener event with
 * `event` and `type` removed, because those describe a *frame* and this is not
 * one — a stream needs to say which kind of thing each line is, a document
 * whose every item is a message does not. `sender` and `recipient` are the
 * `@user/agent` addresses from plan §6.3's `"sender":"@bob/backend"`; they are
 * `null` when the roster no longer names that agent, which happens after a soft
 * delete (D13) and must not be reported as a missing message. `createdAt` and
 * `parentMessageId` are on every message the server returns and are the two
 * fields a thread cannot be reassembled without.
 *
 * Every key above except `recipient` is a key the live delivery puts in a
 * `message` frame (`MessageEnvelope`, plan §4.2), which is what
 * `agentchat listen --json` emits under an added `event: "message"`. The names
 * agree; what does not agree is which keys are **there**, and in all three
 * cases the streamed shape is the one with less:
 *
 * - **`recipient` is never on a `message` frame at all** — not `null`, not
 *   sometimes. A delivery goes to the socket that *is* the recipient, so the
 *   frame has no need of it. A thread read out of `agentchat conversation` is
 *   not in that position, so this rendering carries it; `recipientAgentId` is
 *   on both and is the field to read.
 * - **`parentMessageId` is absent from the frame for a thread root**, where
 *   this document sends `null`.
 * - **`sender` is absent from the frame when the handle cannot be resolved**,
 *   where this document sends `null`. The message is still delivered: a
 *   cosmetic join must not hold one back.
 *
 * The last two are the same decision twice. §12.4 makes an omitted field the
 * additive-safe choice on a wire, while `items` is read as a table and keys
 * that came and went would make it awkward. `?? fallback` reads both, which is
 * why this costs a harness one operator rather than two code paths.
 *
 * The difference is deliberate rather than a drift to be repaired. `listen`
 * passes the server's envelope through verbatim so a field a newer server adds
 * reaches a consumer without a CLI release — right for a stream, and the reason
 * it does not call {@link messageJson}. `tests/inbox.test.ts` asserts the field
 * names, and `tests/e2e/delivery.integration.test.ts` asserts both halves of
 * the difference, rather than leaving this paragraph to be believed.
 *
 * ## What `--json` promises for the listing itself
 *
 * ```json
 * {
 *   "projectId": "prj_…",
 *   "agent": { "id": "agt_…", "address": "@you/backend" },
 *   "status": "pending",
 *   "items": [ … ],
 *   "nextCursor": null,
 *   "complete": true
 * }
 * ```
 *
 * `items` even when it is empty, and a document even when there is nothing
 * pending: a consumer that has to distinguish "no messages" from "the command
 * failed" should not have to do it by checking whether stdout was empty. The
 * human rendering says so in words instead, because a person running this
 * wants to be told it worked.
 *
 * `nextCursor` and `complete` are the paging contract; see below.
 *
 * ## Paging: followed to a ceiling, never truncated quietly
 *
 * `GET /messages` returns one page and a cursor. This command follows the
 * cursor — a queue that is 250 deep is 250 messages of output, not 100 — but it
 * stops after {@link MAX_PAGES} requests and says so: `complete: false` with a
 * `nextCursor` to resume from, and a line on stderr in human mode. A message
 * may be a megabyte (D10), so an unbounded follow is an unbounded read into
 * this process's memory, and the alternative failure — printing the first page
 * and falling silent — is the one that gets mistaken for an empty queue.
 *
 * `--after <msg_…>` resumes, which is what makes the cursor worth reporting.
 *
 * ## `--all` asks for a listing this server may not answer
 *
 * Plan §6.2 gives `inbox` an `--all` for "recent history", and Plan §3 gives
 * `GET /messages` a `status=all` to serve it. **No server implements it yet.**
 * `server/src/routes/messages.ts` parses the parameter in order to refuse it
 * explicitly, and its own note gives the reason: the historical listing has an
 * index waiting for it and no owner, and a route cannot invent one.
 *
 * So `--all` is wired through rather than faked. It sends `status=all`, and a
 * server that answers is believed; a server that refuses produces a failure
 * naming exactly what is missing and what `agentchat inbox` can show instead.
 * Two things were rejected on the way there:
 *
 * - **Falling back to `pending`.** That is the refusal the server explicitly
 *   declined to make, and its note says why: the difference between a client
 *   author waiting for an endpoint and one debugging why `--all` shows only
 *   unread messages.
 * - **Refusing the flag locally.** A newer server that implements the listing
 *   would then need a new CLI to reach it, which is exactly backwards for a
 *   protocol whose compatibility rule (§12.4) is additive.
 *
 * @module
 */

import type { AgentChatClient } from '@stackgrid/client';
import { ApiError } from '@stackgrid/client';
import type {
  AgentId as AgentIdType,
  ListMessagesResponse,
  Message,
  MessageId as MessageIdType,
  MessageListStatus,
  ProjectAgent,
  ProjectId,
} from '@stackgrid/protocol';
import { ErrorCode, MessageId } from '@stackgrid/protocol';

import type { OptionSpecs } from '../args.js';
import type { ClientSeams } from '../client.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext } from '../command.js';
import type { AgentIdentity, ResolvedProject } from '../context.js';
import {
  CONTEXT_OPTIONS,
  contextRequestFor,
  describeProject,
  resolveAgent,
  resolveProject,
} from '../context.js';
import { CliError, UsageError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import type { HumanWriter } from '../output/writer.js';
import { PROGRAM } from '../version.js';
import { addressOf } from './agents.js';
import { requireSender } from './send.js';

/** The usage line, quoted by every failure that is about how it was typed. */
const USAGE = 'inbox [--all] [--after <id>] [--project <slug|id>] [--agent <name|id>] [--json]';

/**
 * How many pages a listing follows before it stops and reports a cursor.
 *
 * Ten, against the server's default page of a hundred, so a thousand messages
 * arrive in one run. The number is a bound on *memory*, not on patience: D10
 * caps one message at 1 MiB, so every page followed is worth up to another
 * hundred megabytes in the worst case a hostile-but-legal sender could arrange.
 * Ten pages is more backlog than a listener that was off overnight accumulates,
 * and past it the cursor is the honest answer.
 */
export const MAX_PAGES = 10;

/** `--project`, `--agent`, and this command's own two. */
const INBOX_OPTIONS: OptionSpecs = Object.freeze({
  ...CONTEXT_OPTIONS,
  all: {
    type: 'boolean',
    description: 'recent history rather than only what is unacknowledged',
  },
  after: {
    type: 'string',
    placeholder: '<id>',
    description: 'resume after this message — a previous run’s `nextCursor`',
  },
});

/**
 * How an agent is addressed in one rendered message, or `null`.
 *
 * `null` rather than the identifier: an address that could not be resolved is
 * absent, not guessed at. `senderAgentId` is beside it and is never absent, so
 * nothing is lost.
 */
export interface MessageParties {
  /** The sender's `@user/agent` address, or `null` if the roster lacks them. */
  readonly sender: string | null;

  /** The recipient's address, or `null` if the roster lacks them. */
  readonly recipient: string | null;
}

/**
 * Looks an agent's address up in a project roster.
 *
 * @param roster - Every agent in the project, as discovery listed them.
 * @returns A function from agent id to address, `null` when the roster does not
 *   name it — which is what a soft-deleted agent looks like (D13).
 */
export function addressLookup(
  roster: readonly ProjectAgent[],
): (agentId: AgentIdType) => string | null {
  const byId = new Map<string, string>(roster.map((row) => [row.agent.id, addressOf(row)]));
  return (agentId: AgentIdType): string | null => byId.get(agentId) ?? null;
}

/**
 * One message, as `--json` renders it.
 *
 * The single message rendering the two polling reads share:
 * `agentchat conversation` calls this rather than growing a second one.
 *
 * `agentchat listen` renders its own, from the delivery frame, and that is a
 * decision rather than a duplication — see the module note, which also lists
 * the three ways the streamed shape differs from this one. The field *names*
 * agree, and `tests/inbox.test.ts` holds them together.
 *
 * @param message - The message, exactly as the server sent it.
 * @param parties - The two addresses, already resolved.
 * @returns The JSON object for this message.
 */
export function messageJson(message: Message, parties: MessageParties): JsonValue {
  return {
    messageId: message.id,
    projectId: message.projectId,
    conversationId: message.conversationId,
    parentMessageId: message.parentMessageId,
    senderAgentId: message.senderAgentId,
    recipientAgentId: message.recipientAgentId,
    sender: parties.sender,
    recipient: parties.recipient,
    content: message.content,
    createdAt: message.createdAt,
  };
}

/**
 * One message, as a person reads it.
 *
 * PRD §38's block, with the identifier and the ready-made reply line plan §6.3
 * adds. Content is written whole and last: nothing is truncated, because a
 * message cut off at the width of somebody's terminal is a message they now
 * have to fetch a second way, and `| less` already exists.
 *
 * @param writer - The rendering being accumulated.
 * @param message - The message.
 * @param parties - The two addresses.
 */
export function renderMessage(
  writer: HumanWriter,
  message: Message,
  parties: MessageParties,
): void {
  writer.blank();
  writer.line(writer.style.dim('[agentchat message]'));
  writer.fields([
    ['id', message.id],
    ['from', parties.sender ?? message.senderAgentId],
    ['to', parties.recipient ?? message.recipientAgentId],
    ['conversation', message.conversationId],
    ['at', message.createdAt],
    [
      'reply',
      parties.sender === null
        ? null
        : `${PROGRAM} send ${parties.sender} --conversation ${message.conversationId} "…"`,
    ],
  ]);
  writer.blank();
  for (const line of message.content.split('\n')) {
    writer.line(line);
  }
}

/** Everything one drained listing produced. */
export interface Drained {
  /** The messages, oldest first, across every page that was read. */
  readonly items: readonly Message[];

  /**
   * Where to resume, or `null` when the listing was read to the end.
   *
   * Non-null with {@link Drained.complete} `false` means the page ceiling
   * stopped the walk, not the server.
   */
  readonly nextCursor: MessageIdType | null;

  /** Whether the walk reached the end of the listing. */
  readonly complete: boolean;
}

/** One page of a cursor-paged listing, as either endpoint returns it. */
export interface Page {
  /** The messages on this page, oldest first. */
  readonly items: readonly Message[];

  /** Where to resume, or `null` at the end. */
  readonly nextCursor: MessageIdType | null;
}

/**
 * Follows a cursor to the end of a listing, or to {@link MAX_PAGES}.
 *
 * Shared by `inbox` and `conversation` because they page identically — the
 * cursor is a message id and the order is by message id on both endpoints — and
 * because "how much does one invocation read?" is a decision that should have
 * one answer rather than one per command.
 *
 * @param fetch - Reads one page, resuming after the given cursor. `undefined`
 *   asks for the first page.
 * @returns Everything read, and whether that was all of it.
 */
export async function drain(
  fetch: (after: MessageIdType | undefined) => Promise<Page>,
): Promise<Drained> {
  const items: Message[] = [];
  let cursor: MessageIdType | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const received = await fetch(cursor);
    items.push(...received.items);
    if (received.nextCursor === null) {
      return { items, nextCursor: null, complete: true };
    }
    cursor = received.nextCursor;
  }

  return { items, nextCursor: cursor ?? null, complete: false };
}

/**
 * Reads a message identifier passed as an option.
 *
 * @param raw - The flag's value, if it was given.
 * @param flag - The flag's name, for the message.
 * @returns The identifier, or `undefined` when the flag was absent.
 * @throws {UsageError} When the value is not a `msg_` identifier.
 */
export function optionalCursor(raw: string | undefined, flag: string): MessageIdType | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (MessageId.is(raw)) {
    return raw;
  }
  throw new UsageError(
    `\`--${flag}\` is \`${truncate(raw)}\`, which is not a message identifier (\`${MessageId.prefix}<uuidv7>\`).`,
    {
      hint: `Pass the \`nextCursor\` a previous \`--json\` run reported. Usage: ${PROGRAM} ${USAGE}`,
    },
  );
}

/**
 * Renders an untrusted value for a message, bounded.
 *
 * @param value - The value.
 * @returns It, truncated at 48 characters.
 */
export function truncate(value: string): string {
  return value.length > 48 ? `${value.slice(0, 48)}…` : value;
}

/**
 * Turns a project reference into an identifier.
 *
 * The fourth copy of this walk in `src/commands/` — `./send.ts`, `./project.ts`
 * and `./agent.ts` each hold one, and `./agents.ts` holds the wider version that
 * keeps the whole membership row. They are not collapsed here for the reason
 * `../client.ts` gives about the client construction it did collapse: doing it
 * means editing four command files at once, and T-036 is the task that owns
 * that. This one is exported so that `./ack.ts` at least does not become a
 * fifth.
 *
 * @param client - The client to ask.
 * @param project - The resolved project.
 * @param signal - The interrupt signal.
 * @returns The project's identifier.
 * @throws {CliError} `NOT_FOUND` when the caller is in no such project.
 */
export async function projectIdFor(
  client: AgentChatClient,
  project: ResolvedProject,
  signal: AbortSignal,
): Promise<ProjectId> {
  if (project.id !== null) {
    return project.id;
  }

  const { items } = await client.projects.list({ signal });
  const match = items.find((membership) => membership.slug === project.slug);
  if (match !== undefined) {
    return match.id;
  }

  throw new CliError(
    ErrorCode.NOT_FOUND,
    `You are not in a project called \`${truncate(project.slug ?? '')}\`.`,
    {
      hint: `That came from ${project.origin}. \`${PROGRAM} project list\` shows the projects you are in.`,
    },
  );
}

/** Which agent, in which project, with the roster that named them. */
export interface QueueContext {
  /** The project the queue is scoped to. */
  readonly projectId: ProjectId;

  /** The project as resolution found it, for the messages. */
  readonly project: ResolvedProject;

  /** Every agent in the project, for turning identifiers into addresses. */
  readonly roster: readonly ProjectAgent[];

  /** The agent this invocation acts as. */
  readonly agent: ProjectAgent;
}

/**
 * Resolves the `(agent, project)` pair the inbox is keyed on (D3).
 *
 * Three round trips at most and two in the common case: the project listing
 * only when a slug has to become an id, then the roster and `GET /me` in
 * parallel — the roster answers "which of these are mine" and "what is each one
 * called", and `/me` is what says which rows are the caller's.
 *
 * Shared with `./ack.ts`, which needs exactly the same pair for exactly the
 * same reason: an acknowledgement is scoped to `(agent, project)` too.
 *
 * @param client - The client to ask.
 * @param context - The command context.
 * @returns The project, the roster, and the agent this invocation acts as.
 * @throws {CliError} `NO_PROJECT` or `NO_AGENT` when context cannot be
 *   resolved; `AGENT_NOT_IN_PROJECT` when the chosen agent is not the caller's
 *   here.
 */
export async function resolveQueue(
  client: AgentChatClient,
  context: CommandContext,
): Promise<QueueContext> {
  const project = await resolveProject(contextRequestFor(context));
  const projectId = await projectIdFor(client, project, context.signal);

  const [roster, me] = await Promise.all([
    client.projects.listAgents(projectId, { signal: context.signal }),
    client.auth.me({ signal: context.signal }),
  ]);

  const own = roster.items.filter((row) => row.owner.id === me.id);
  const identities: readonly AgentIdentity[] = own.map((row) => ({
    id: row.agent.id,
    name: row.agent.name,
  }));
  const agent = requireSender(
    await resolveAgent(
      project,
      contextRequestFor(context, { agents: () => Promise.resolve(identities) }),
    ),
    own,
    project,
  );

  return { projectId, project, roster: roster.items, agent };
}

/** Everything the listing is rendered from. */
export interface InboxListing {
  /** The queue's `(agent, project)` pair and the roster behind it. */
  readonly queue: QueueContext;

  /** Which listing was asked for. */
  readonly status: MessageListStatus;

  /** What was read. */
  readonly drained: Drained;
}

/**
 * The inbox, in both representations.
 *
 * @param listing - The queue and what it produced.
 * @returns The view. See the module note for what the JSON promises.
 */
export function inboxView(listing: InboxListing): View {
  const { queue, drained } = listing;
  const address = addressOf(queue.agent);
  const lookup = addressLookup(queue.roster);
  const parties = (message: Message): MessageParties => ({
    sender: lookup(message.senderAgentId),
    recipient: lookup(message.recipientAgentId),
  });

  const json: JsonValue = {
    projectId: queue.projectId,
    agent: { id: queue.agent.agent.id, address },
    status: listing.status,
    items: drained.items.map((message) => messageJson(message, parties(message))),
    nextCursor: drained.nextCursor,
    complete: drained.complete,
  };

  return view(json, (writer) => {
    const where = describeProject(queue.project);
    writer.line(
      `${writer.style.dim(listing.status === 'pending' ? 'PENDING FOR' : 'HISTORY FOR')} ${writer.style.bold(address)} ${writer.style.dim(`in ${where}`)}`,
    );

    if (drained.items.length === 0) {
      writer.blank();
      // Said out loud, because "it worked and there is nothing" and "it did not
      // run" look identical when a command prints nothing at all.
      writer.line(
        listing.status === 'pending'
          ? `Nothing pending. Every message addressed to ${address} here has been acknowledged.`
          : `No messages. Nothing has been sent to or from ${address} here.`,
      );
      writer.blank();
      writer.line(
        writer.style.dim(
          `Wait for one with \`${PROGRAM} listen --runtime <name>\`, or send one with \`${PROGRAM} send <@user/agent> "…"\`.`,
        ),
      );
      return;
    }

    for (const message of drained.items) {
      renderMessage(writer, message, parties(message));
    }

    writer.blank();
    writer.line(
      writer.style.dim(
        `${String(drained.items.length)} message${drained.items.length === 1 ? '' : 's'}. Clear ${drained.items.length === 1 ? 'it' : 'them'} with \`${PROGRAM} ack ${drained.items.map((message) => message.id).join(' ')}\`.`,
      ),
    );
    if (!drained.complete && drained.nextCursor !== null) {
      writer.line(
        writer.style.dim(
          `More remain. Read the next ${String(MAX_PAGES)} pages with \`${PROGRAM} inbox --after ${drained.nextCursor}\`.`,
        ),
      );
    }
  });
}

/**
 * Turns the server's refusal of `status=all` into a sentence.
 *
 * The server answers `BAD_REQUEST` naming the missing half, which is the right
 * answer and the wrong audience: it is written for whoever is building a
 * client, not for whoever typed a flag. This keeps the server's own sentence as
 * the hint and puts the remedy first.
 *
 * @param error - Whatever the listing threw.
 * @param status - Which listing was asked for.
 * @returns The error to raise instead. The original, unless it is the refusal.
 */
export function describeListingFailure(error: unknown, status: MessageListStatus): unknown {
  if (status !== 'all' || !(error instanceof ApiError) || error.code !== ErrorCode.BAD_REQUEST) {
    return error;
  }
  return new CliError(
    ErrorCode.BAD_REQUEST,
    `This server does not have the historical listing that \`--all\` reads, so there is no recent history to show. \`${PROGRAM} inbox\` without the flag shows everything still unacknowledged.`,
    {
      hint: `The server said: ${error.message} To read a thread you already know the identifier of, use \`${PROGRAM} conversation <id>\`.`,
    },
  );
}

/**
 * Runs `agentchat inbox`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the listing has been written.
 */
async function inbox(context: CommandContext, overrides: ClientSeams): Promise<void> {
  const status: MessageListStatus = context.args.flag('all') ? 'all' : 'pending';
  const after = optionalCursor(context.args.value('after'), 'after');

  const client = await clientFor(context, overrides);
  const queue = await resolveQueue(client, context);

  const drained = await drain(async (cursor: MessageIdType | undefined) => {
    const resume = cursor ?? after;
    try {
      const page: ListMessagesResponse = await client.messages.list(
        {
          projectId: queue.projectId,
          agentId: queue.agent.agent.id,
          status,
          ...(resume === undefined ? {} : { after: resume }),
        },
        { signal: context.signal },
      );
      return { items: page.items, nextCursor: page.nextCursor };
    } catch (error) {
      throw describeListingFailure(error, status);
    }
  });

  if (!drained.complete) {
    context.log.warn(
      `Stopped after ${String(MAX_PAGES)} pages; more messages remain. Resume with \`--after ${String(drained.nextCursor)}\`.`,
    );
  }

  await context.emit(inboxView({ queue, status, drained }));
}

/**
 * Builds `agentchat inbox`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createInboxCommand(overrides: ClientSeams = {}): Command {
  return {
    kind: 'command',
    name: 'inbox',
    summary: 'read messages waiting for your agent, without holding a connection',
    usage: USAGE,
    options: INBOX_OPTIONS,
    details: [
      'The polling half of the product. `agentchat listen` is told about messages; this asks, which is what an agent harness that cannot keep a process alive between turns needs.',
      'Reading changes nothing: a message stays pending until it is acknowledged, so this can be run as often as you like. Clear what you have handled with `agentchat ack`.',
      '`--all` asks for recent history rather than only what is unacknowledged. No server implements that listing yet, and one that does not says so rather than quietly showing you the pending queue instead.',
      '`--json` emits one document carrying `items`, `nextCursor` and `complete`. An item is not quite what `agentchat listen --json` streams: a streamed `message` event carries no `recipient` at all, and omits `sender` and `parentMessageId` where an item has them as `null`. Read `recipientAgentId`, which both carry, and `?? null` reads absent and null alike. Full table in `docs/cli.md`.',
      'A long queue is followed across pages up to a documented ceiling. When the ceiling stops it, `complete` is false and `nextCursor` says where `--after` should resume.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return inbox(context, overrides);
    },
  };
}

/** `agentchat inbox`. */
export const inboxCommand: Command = createInboxCommand();
