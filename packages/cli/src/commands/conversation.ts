/**
 * `agentchat conversation <id>` — one thread, in order, with senders (plan
 * §6.2, PRD §36).
 *
 * ```text
 * agentchat conversation cnv_0199…
 * agentchat conversation cnv_0199… --json | jq -r '.items[] | "\(.sender): \(.content)"'
 * ```
 *
 * This is the command somebody runs after `agentchat inbox` hands them a
 * `conversationId`, or after `agentchat send --json` reports the thread it
 * opened. It is the only read in the product that is addressed by a thread
 * rather than by an agent, which has one pleasant consequence: it needs no
 * project and no agent context at all. A `cnv_` identifier says which project
 * it belongs to, and the server decides whether the caller may read it. So this
 * works from a directory with no repository configuration, which is exactly
 * where somebody debugging a delivery tends to be.
 *
 * ## What `--json` promises
 *
 * ```json
 * {
 *   "conversation": { "id": "cnv_…", "projectId": "prj_…", "createdAt": "…" },
 *   "items": [ … ],
 *   "nextCursor": null,
 *   "complete": true
 * }
 * ```
 *
 * Each item is `inbox`'s message object, unchanged — see `./inbox.ts` for the
 * field-by-field reasoning. One shape for a message that just arrived, a
 * message replayed on reconnect, and a message read out of a thread an hour
 * later, because they are one thing and a harness must not parse three.
 *
 * ## Order, and what "in order" is allowed to mean
 *
 * Oldest first, as the server sent it. The server orders by message id, which
 * is chronological because a `msg_` identifier is a UUIDv7, and nothing here
 * sorts again: a client and a server with two ideas of order produce output
 * that flaps between runs for no visible reason. `createdAt` is on every item
 * for anyone who wants to render a time, and it is the authority for what a
 * human reads.
 *
 * ## A long thread is paged, and the paging is visible
 *
 * Plan §3 wrote this read as returning the thread whole. T-301 measured why it
 * cannot: a thread has no upper bound, each message may be a megabyte (D10),
 * and the read is the one that cannot avoid a sort. So the endpoint pages, and
 * this command **follows the cursor** rather than printing a first page and
 * falling silent — `conversation` that showed the oldest hundred messages of a
 * live thread and stopped would be worse than useless, because the part
 * everybody wants is the end.
 *
 * It follows to `MAX_PAGES` and no further, and when the ceiling stops it that
 * is reported rather than hidden: `complete: false`, a `nextCursor`, a line on
 * stderr, and `--after` to resume. The ceiling is a bound on this process's
 * memory; see `./inbox.ts`.
 *
 * ## Senders are addresses, and cost one request
 *
 * The endpoint returns agent identifiers, and "with senders" in the acceptance
 * criteria means `@bob/backend`, not `agt_0199…`. The addresses come from one
 * `GET /projects/:id/agents` against the project the thread belongs to — which
 * the first page is what tells us, so the request cannot be issued any earlier.
 *
 * That request is allowed to fail without failing the command. A thread is
 * readable and its roster is not, for instance, in the moment after a
 * membership is revoked; refusing to print correspondence the server just
 * handed over, because the *decoration* could not be fetched, would be the
 * wrong trade. The addresses become `null`, the identifiers are still there,
 * and stderr says why.
 *
 * @module
 */

import type { AgentChatClient } from '@agentchat/client';
import type {
  Conversation,
  ConversationId as ConversationIdType,
  Message,
  MessageId as MessageIdType,
  ProjectAgent,
} from '@agentchat/protocol';
import { ConversationId } from '@agentchat/protocol';

import type { OptionSpecs } from '../args.js';
import type { ClientSeams } from '../client.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext } from '../command.js';
import { UsageError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { PROGRAM } from '../version.js';
import type { Drained, MessageParties } from './inbox.js';
import {
  addressLookup,
  drain,
  MAX_PAGES,
  messageJson,
  optionalCursor,
  renderMessage,
  truncate,
} from './inbox.js';

/** The usage line, quoted by every failure that is about how it was typed. */
const USAGE = 'conversation <id> [--after <id>] [--json]';

/**
 * This command's only option beyond the global ones.
 *
 * Deliberately no `--project` and no `--agent`. A conversation identifier names
 * its own project and the server applies D15 per message, so neither flag would
 * change the answer — and a flag that parses and does nothing is still promised
 * by `--help`.
 */
const CONVERSATION_OPTIONS: OptionSpecs = Object.freeze({
  after: {
    type: 'string',
    placeholder: '<id>',
    description: 'resume after this message — a previous run’s `nextCursor`',
  },
});

/**
 * Reads the conversation identifier from the command line.
 *
 * @param raw - The first positional argument.
 * @returns The identifier.
 * @throws {UsageError} When it is not a `cnv_` identifier. The message names
 *   the two commands that print real ones, because a thread identifier is never
 *   something a person invents.
 */
export function parseConversationId(raw: string): ConversationIdType {
  if (ConversationId.is(raw)) {
    return raw;
  }
  throw new UsageError(
    `\`${truncate(raw)}\` is not a conversation identifier (\`${ConversationId.prefix}<uuidv7>\`).`,
    {
      hint: `\`${PROGRAM} inbox --json\` and \`${PROGRAM} send --json\` both report the \`conversationId\` of every message. Usage: ${PROGRAM} ${USAGE}`,
    },
  );
}

/** Everything the thread is rendered from. */
export interface ConversationReading {
  /** The thread the server allowed the caller to read. */
  readonly conversation: Conversation;

  /** The project's roster, for addresses. Empty when it could not be read. */
  readonly roster: readonly ProjectAgent[];

  /** The messages, and how far the walk got. */
  readonly drained: Drained;
}

/**
 * The thread, in both representations.
 *
 * @param reading - The thread and what was read of it.
 * @returns The view. See the module note for what the JSON promises.
 */
export function conversationView(reading: ConversationReading): View {
  const { conversation, drained } = reading;
  const lookup = addressLookup(reading.roster);
  const parties = (message: Message): MessageParties => ({
    sender: lookup(message.senderAgentId),
    recipient: lookup(message.recipientAgentId),
  });

  const json: JsonValue = {
    conversation: {
      id: conversation.id,
      projectId: conversation.projectId,
      createdAt: conversation.createdAt,
    },
    items: drained.items.map((message) => messageJson(message, parties(message))),
    nextCursor: drained.nextCursor,
    complete: drained.complete,
  };

  return view(json, (writer) => {
    writer.line(`${writer.style.dim('CONVERSATION')} ${writer.style.bold(conversation.id)}`);
    writer.fields([
      ['project', conversation.projectId],
      ['opened', conversation.createdAt],
    ]);

    if (drained.items.length === 0) {
      writer.blank();
      // Reachable: D15 is applied per message, so a thread the caller may open
      // can still hold no message they may read.
      writer.line('No messages in this thread that you can read.');
      return;
    }

    for (const message of drained.items) {
      renderMessage(writer, message, parties(message));
    }

    writer.blank();
    writer.line(
      writer.style.dim(
        `${String(drained.items.length)} message${drained.items.length === 1 ? '' : 's'}, oldest first.`,
      ),
    );
    if (!drained.complete && drained.nextCursor !== null) {
      writer.line(
        writer.style.dim(
          `The thread is longer than ${String(MAX_PAGES)} pages. Continue with \`${PROGRAM} conversation ${conversation.id} --after ${drained.nextCursor}\`.`,
        ),
      );
    }
  });
}

/**
 * Reads the project's roster, or gives up and says so.
 *
 * @param client - The client to ask.
 * @param conversation - The thread, which is what names the project.
 * @param context - The command context, for the interrupt and for stderr.
 * @returns The roster, or an empty list when it could not be read — in which
 *   case addresses render as `null` and the identifiers carry the meaning.
 */
async function rosterFor(
  client: AgentChatClient,
  conversation: Conversation,
  context: CommandContext,
): Promise<readonly ProjectAgent[]> {
  try {
    const { items } = await client.projects.listAgents(conversation.projectId, {
      signal: context.signal,
    });
    return items;
  } catch {
    context.log.warn(
      'Could not read the project roster, so senders are shown as agent identifiers rather than addresses. The messages themselves are unaffected.',
    );
    return [];
  }
}

/**
 * Runs `agentchat conversation`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the thread has been written.
 */
async function conversation(context: CommandContext, overrides: ClientSeams): Promise<void> {
  const conversationId = parseConversationId(
    context.args.required(0, 'the conversation to read', `${PROGRAM} ${USAGE}`),
  );
  const after = optionalCursor(context.args.value('after'), 'after');

  const client = await clientFor(context, overrides);

  // Captured from the first page. Every page carries it and they agree, so the
  // first one to arrive wins and the rest are ignored.
  let thread: Conversation | undefined;

  const drained = await drain(async (cursor: MessageIdType | undefined) => {
    const resume = cursor ?? after;
    const page = await client.conversations.read(
      conversationId,
      resume === undefined ? {} : { after: resume },
      { signal: context.signal },
    );
    thread ??= page.conversation;
    return { items: page.messages, nextCursor: page.nextCursor };
  });

  if (thread === undefined) {
    // Unreachable: `drain` performs at least one request, and a request that
    // does not throw returns a conversation. Stated rather than asserted away.
    throw new UsageError(`\`${conversationId}\` could not be read.`);
  }

  if (!drained.complete) {
    context.log.warn(
      `Stopped after ${String(MAX_PAGES)} pages; the thread continues. Resume with \`--after ${String(drained.nextCursor)}\`.`,
    );
  }

  const roster = await rosterFor(client, thread, context);
  await context.emit(conversationView({ conversation: thread, roster, drained }));
}

/**
 * Builds `agentchat conversation`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createConversationCommand(overrides: ClientSeams = {}): Command {
  return {
    kind: 'command',
    name: 'conversation',
    summary: 'print one thread in order, with senders',
    usage: USAGE,
    options: CONVERSATION_OPTIONS,
    positionals: { min: 1, max: 1 },
    details: [
      'Takes the `conversationId` that `agentchat inbox --json`, `agentchat listen --json` and `agentchat send --json` all report. It needs no project or agent context of its own: the identifier names its project, and the server decides what you may read.',
      'Messages are printed oldest first, in the order the server returned them. A thread may hold messages between agents you own neither end of; those are absent rather than hidden, so a thread can read as shorter than it is.',
      'A long thread is followed across pages up to a documented ceiling. When the ceiling stops it, `complete` is false and `nextCursor` says where `--after` should resume; nothing is ever cut off silently.',
      '`--json` emits one document carrying `conversation`, `items`, `nextCursor` and `complete`. Each item is the same message shape `agentchat inbox` and `agentchat listen` emit.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return conversation(context, overrides);
    },
  };
}

/** `agentchat conversation`. */
export const conversationCommand: Command = createConversationCommand();
