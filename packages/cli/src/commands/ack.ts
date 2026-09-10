/**
 * `agentchat ack <msgId>…` — clearing messages by hand (plan §6.2, D3).
 *
 * ```text
 * agentchat listen --runtime codex --no-ack --json | my-harness
 * agentchat ack msg_0199… msg_019a…
 * ```
 *
 * Acknowledging is normally automatic: `agentchat listen` sends one after the
 * write to stdout has flushed, which is what makes a crashed pipe replay rather
 * than lose. This command is the other half of `--no-ack`, and the companion to
 * `agentchat inbox` for a harness that polls instead of listening. In both
 * cases the caller has taken responsibility for the message and is now saying
 * so.
 *
 * ## A repeat is a success, and that is the whole design
 *
 * D3 makes an acknowledgement idempotent: a message already cleared — by this
 * agent's other session, by a `listen` that was running at the time, or by an
 * earlier attempt of this same command — is answered `alreadyAcknowledged:
 * true` and nothing is rewritten. This command **must not** report that as a
 * failure, because a harness that retries hits it constantly and by design:
 * every acknowledgement racing a replay produces one, and so does every
 * re-issued command after a dropped connection.
 *
 * So a repeat exits 0, is counted separately in `counts.alreadyAcknowledged`,
 * and says one dim line in the human rendering. It is *reported* rather than
 * hidden for the same reason `agentchat send` reports a duplicate: it is the
 * only explanation for an `acknowledgedAt` that is older than the command that
 * just returned.
 *
 * ## Every identifier is attempted, and the exit code is the summary
 *
 * A run over five identifiers where the third does not exist acknowledges the
 * other four. Stopping at the first failure would leave a harness holding four
 * messages it had already handled and no record of which, and re-running would
 * be safe but would not tell it which four. So each is attempted in the order
 * given, each gets a row in `items`, and the exit code is non-zero if any
 * failed — the document says which.
 *
 * Identifiers are validated *before* the first request. A typo in the fifth
 * argument is the caller's mistake about the whole invocation, and finding out
 * after four have been acknowledged makes it a mistake they have to reason
 * about.
 *
 * The only failure to expect is `NOT_FOUND`, which the server answers for a
 * message that is not owed to this agent in this project — including one that
 * does not exist, deliberately the same answer, because a caller who may not
 * acknowledge a message may not learn that it exists.
 *
 * ## What `--json` promises
 *
 * ```json
 * {
 *   "projectId": "prj_…",
 *   "agent": { "id": "agt_…", "address": "@you/backend" },
 *   "items": [
 *     {
 *       "messageId": "msg_…",
 *       "acknowledged": true,
 *       "alreadyAcknowledged": false,
 *       "acknowledgedAt": "2026-09-09T12:00:00.000Z",
 *       "acknowledgedBySessionId": null,
 *       "error": null
 *     }
 *   ],
 *   "counts": { "acknowledged": 1, "alreadyAcknowledged": 0, "failed": 0 }
 * }
 * ```
 *
 * `acknowledged` is true for a repeat as well — it answers "is this message
 * cleared?", which is the question a caller has, and `alreadyAcknowledged`
 * answers the narrower "did this call clear it?". `acknowledgedAt` is when the
 * debt was *first* settled, so a retry does not appear to settle it again.
 *
 * When something failed, the document is still written, and a second line
 * carries the usual error envelope. That is one NDJSON stream with the summary
 * first, which is the order a consumer wants: the failure is a property of the
 * run, and the run's result is what says which parts of it succeeded.
 *
 * @module
 */

import type { AgentChatClient } from '@stackgrid/client';
import { ApiError } from '@stackgrid/client';
import type {
  AcknowledgeMessageResponse,
  MessageId as MessageIdType,
  SessionId as SessionIdType,
} from '@stackgrid/protocol';
import { ErrorCode, MessageId, SessionId } from '@stackgrid/protocol';

import type { OptionSpecs } from '../args.js';
import type { ClientSeams } from '../client.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext } from '../command.js';
import { CONTEXT_OPTIONS, describeProject } from '../context.js';
import { CliError, UsageError } from '../errors.js';
import type { JsonValue, View } from '../output/output.js';
import { view } from '../output/output.js';
import { PROGRAM } from '../version.js';
import { addressOf } from './agents.js';
import type { QueueContext } from './inbox.js';
import { resolveQueue, truncate } from './inbox.js';

/** The usage line, quoted by every failure that is about how it was typed. */
const USAGE = 'ack <msgId>… [--session <id>] [--project <slug|id>] [--agent <name|id>] [--json]';

/** `--project`, `--agent`, and this command's own one. */
const ACK_OPTIONS: OptionSpecs = Object.freeze({
  ...CONTEXT_OPTIONS,
  session: {
    type: 'string',
    placeholder: '<id>',
    description: 'the session the message arrived on, recorded for diagnostics',
  },
});

/** What acknowledging one message did. */
export interface AckOutcome {
  /** The message that was named. */
  readonly messageId: MessageIdType;

  /** The server's answer, or `null` when the call failed. */
  readonly result: AcknowledgeMessageResponse | null;

  /** Why it failed, or `null` when it did not. */
  readonly failure: { readonly code: string; readonly message: string } | null;
}

/**
 * Reads the identifiers to acknowledge, rejecting the whole invocation if any
 * is malformed.
 *
 * Duplicates are collapsed, keeping the first occurrence's position. Sending
 * the same identifier twice would be harmless — that is what idempotency is —
 * but it would put two rows in `items` for one message, and a consumer counting
 * rows would then disagree with itself about how many messages it cleared.
 *
 * @param positionals - Everything after the command name.
 * @returns The identifiers, in order, without repeats.
 * @throws {UsageError} When any argument is not a `msg_` identifier. Nothing is
 *   acknowledged; see the module note.
 */
export function parseMessageIds(positionals: readonly string[]): readonly MessageIdType[] {
  const seen = new Set<string>();
  const ids: MessageIdType[] = [];

  for (const raw of positionals) {
    if (!MessageId.is(raw)) {
      throw new UsageError(
        `\`${truncate(raw)}\` is not a message identifier (\`${MessageId.prefix}<uuidv7>\`).`,
        {
          hint: `Nothing was acknowledged. \`${PROGRAM} inbox --json\` reports the \`messageId\` of everything waiting. Usage: ${PROGRAM} ${USAGE}`,
        },
      );
    }
    if (!seen.has(raw)) {
      seen.add(raw);
      ids.push(raw);
    }
  }

  return ids;
}

/**
 * Reads `--session`, which the server records and never consults.
 *
 * @param raw - The flag's value, if it was given.
 * @returns The identifier, or `undefined` when the flag was absent.
 * @throws {UsageError} When the value is not a `ses_` identifier.
 */
export function parseSessionId(raw: string | undefined): SessionIdType | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (SessionId.is(raw)) {
    return raw;
  }
  throw new UsageError(
    `\`--session\` is \`${truncate(raw)}\`, which is not a session identifier (\`${SessionId.prefix}<uuidv7>\`).`,
    {
      hint: `It is recorded for diagnostics and never affects what an acknowledgement clears (D3), so omitting it is always safe. Usage: ${PROGRAM} ${USAGE}`,
    },
  );
}

/** Everything the receipt is rendered from. */
export interface AckReceipt {
  /** The `(agent, project)` pair the acknowledgements were scoped to. */
  readonly queue: QueueContext;

  /** One entry per identifier, in the order they were given. */
  readonly outcomes: readonly AckOutcome[];
}

/**
 * The result of a run, in both representations.
 *
 * @param receipt - What was attempted and what happened.
 * @returns The view. See the module note for what the JSON promises.
 */
export function ackView(receipt: AckReceipt): View {
  const address = addressOf(receipt.queue.agent);
  const cleared = receipt.outcomes.filter((outcome) => outcome.result !== null);
  const repeats = cleared.filter((outcome) => outcome.result?.alreadyAcknowledged === true);
  const failures = receipt.outcomes.filter((outcome) => outcome.failure !== null);

  const json: JsonValue = {
    projectId: receipt.queue.projectId,
    agent: { id: receipt.queue.agent.agent.id, address },
    items: receipt.outcomes.map((outcome) => ({
      messageId: outcome.messageId,
      acknowledged: outcome.result !== null,
      alreadyAcknowledged: outcome.result?.alreadyAcknowledged ?? false,
      acknowledgedAt: outcome.result?.acknowledgedAt ?? null,
      acknowledgedBySessionId: outcome.result?.acknowledgedBySessionId ?? null,
      error:
        outcome.failure === null
          ? null
          : { code: outcome.failure.code, message: outcome.failure.message },
    })),
    counts: {
      acknowledged: cleared.length,
      alreadyAcknowledged: repeats.length,
      failed: failures.length,
    },
  };

  return view(json, (writer) => {
    writer.line(
      `${writer.style.dim('ACKNOWLEDGED FOR')} ${writer.style.bold(address)} ${writer.style.dim(`in ${describeProject(receipt.queue.project)}`)}`,
    );
    writer.blank();

    for (const outcome of receipt.outcomes) {
      if (outcome.failure !== null) {
        writer.line(`${writer.style.red('failed')}  ${outcome.messageId}`);
        writer.line(`        ${writer.style.dim(outcome.failure.message)}`);
        continue;
      }
      const already = outcome.result?.alreadyAcknowledged === true;
      writer.line(
        `${already ? writer.style.dim('already') : writer.style.green('cleared')}  ${outcome.messageId}`,
      );
    }

    writer.blank();
    if (repeats.length > 0) {
      writer.line(
        writer.style.dim(
          `${String(repeats.length)} of these had already been acknowledged, which is a success: any session of ${address} clears a message for all of them.`,
        ),
      );
    }
    if (failures.length === 0) {
      writer.line(
        writer.style.dim(
          `Nothing is owed for ${String(cleared.length)} message${cleared.length === 1 ? '' : 's'}. \`${PROGRAM} inbox\` shows what still is.`,
        ),
      );
    }
  });
}

/**
 * Acknowledges one message, turning a refusal into a row rather than a throw.
 *
 * @param client - The client to acknowledge with.
 * @param queue - The `(agent, project)` pair the queue is keyed on.
 * @param messageId - The message to clear.
 * @param sessionId - The session to record, if one was named.
 * @param context - The command context, for the interrupt.
 * @returns What happened to this one message.
 * @throws Anything that is not an answer from the server. A transport failure
 *   or an expired credential is about the run rather than about this message,
 *   and turning it into a per-message row would report five failures for one
 *   cause.
 */
async function acknowledgeOne(
  client: AgentChatClient,
  queue: QueueContext,
  messageId: MessageIdType,
  sessionId: SessionIdType | undefined,
  context: CommandContext,
): Promise<AckOutcome> {
  try {
    const result = await client.messages.acknowledge(
      messageId,
      {
        agentId: queue.agent.agent.id,
        projectId: queue.projectId,
        ...(sessionId === undefined ? {} : { sessionId }),
      },
      { signal: context.signal },
    );
    return { messageId, result, failure: null };
  } catch (error) {
    if (!(error instanceof ApiError)) {
      throw error;
    }
    return {
      messageId,
      result: null,
      failure: { code: error.wireCode, message: error.message },
    };
  }
}

/**
 * The failure to raise once every identifier has been attempted.
 *
 * @param receipt - What the run produced.
 * @returns The error, or `null` when nothing failed.
 */
export function ackFailure(receipt: AckReceipt): CliError | null {
  const failures = receipt.outcomes.filter((outcome) => outcome.failure !== null);
  if (failures.length === 0) {
    return null;
  }

  const cleared = receipt.outcomes.length - failures.length;
  const named = failures.map((outcome) => outcome.messageId).join(', ');
  return new CliError(
    ErrorCode.NOT_FOUND,
    failures.length === receipt.outcomes.length
      ? `Could not acknowledge ${named}.`
      : `Acknowledged ${String(cleared)} of ${String(receipt.outcomes.length)}; could not acknowledge ${named}.`,
    {
      hint: `A message can only be acknowledged by the agent it was addressed to, in the project it was sent in — \`${PROGRAM} inbox\` lists what is owed to ${addressOf(receipt.queue.agent)} here. Everything that did succeed is on stdout and stays acknowledged.`,
    },
  );
}

/**
 * Runs `agentchat ack`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the receipt has been written.
 * @throws {CliError} `NOT_FOUND` when any identifier could not be acknowledged.
 *   Thrown after the receipt, so the successes are reported either way.
 */
async function ack(context: CommandContext, overrides: ClientSeams): Promise<void> {
  const messageIds = parseMessageIds(context.args.positionals);
  const sessionId = parseSessionId(context.args.value('session'));

  const client = await clientFor(context, overrides);
  const queue = await resolveQueue(client, context);

  // One at a time, in the order given. They are independent and could be
  // issued together, but a burst of acknowledgements against one queue row per
  // message buys nothing a human would notice and makes the order of `items`
  // depend on scheduling rather than on what was typed.
  const outcomes: AckOutcome[] = [];
  for (const messageId of messageIds) {
    outcomes.push(await acknowledgeOne(client, queue, messageId, sessionId, context));
  }

  const receipt: AckReceipt = { queue, outcomes };
  await context.emit(ackView(receipt));

  const failure = ackFailure(receipt);
  if (failure !== null) {
    throw failure;
  }
}

/**
 * Builds `agentchat ack`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createAckCommand(overrides: ClientSeams = {}): Command {
  return {
    kind: 'command',
    name: 'ack',
    summary: 'acknowledge messages by hand, for use with `listen --no-ack`',
    usage: USAGE,
    options: ACK_OPTIONS,
    positionals: { min: 1, max: 'many' },
    details: [
      'Takes the `messageId` that `agentchat inbox --json` and `agentchat listen --json` report. Several may be given at once; each is attempted, and the result says what happened to each.',
      'Acknowledging a message that was already acknowledged is a success, not an error. Any session of your agent clears a message for all of them (D3), so a retry, a re-run, and an acknowledgement that raced a replay all land here and all exit 0.',
      'A message can only be acknowledged by the agent it was addressed to, in the project it was sent in. Anything else is reported as not found, which is also the answer for a message that does not exist.',
      '`--json` emits one document carrying `items` and `counts`. If anything failed, the document is still written and the error follows it on a second line.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return ack(context, overrides);
    },
  };
}

/** `agentchat ack`. */
export const ackCommand: Command = createAckCommand();
