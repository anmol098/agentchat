/**
 * `agentchat send` — the writing half of the product (plan §6.2, PRD §37).
 *
 * ```text
 * agentchat send @alice/backend "the build is green"
 * generate-release-notes | agentchat send @alice/backend -
 * agentchat send @alice/backend --reply-to msg_0199… "on it"
 * ```
 *
 * Everything below follows from who runs this. It is not mainly a person
 * typing; it is another AI coding agent, in a script, with a body it generated
 * on standard input and a `--json` document it is about to parse. So the
 * interesting decisions here are all about being driven rather than about being
 * read.
 *
 * ## A body of `-` is read whole, and verbatim
 *
 * `-` is the conventional name for standard input, and `./args.ts` already
 * declines to treat a bare `-` as an option so that it arrives here as a
 * positional. What arrives is then passed through **unchanged**: no trailing
 * newline is stripped, no CRLF is folded, nothing is trimmed.
 *
 * That is a deliberate refusal of the friendlier-looking option. Trimming one
 * trailing newline would make `echo hi |` read nicely and would make it
 * impossible to send a body that genuinely ends in a newline — a file, a diff,
 * a generated document — because there would be no way to opt out. Adding a
 * newline is `printf '%s\n'`; removing one the CLI insisted on removing is
 * nothing. Verbatim is the strictly more expressive of the two.
 *
 * The read does not go through `StreamSource`, which is the shared reader for
 * *prompts*: it is line-oriented and folds CRLF, which is right for an answer
 * to a question and is exactly the mangling a message body must not suffer. The
 * decoder here is stateful across chunks for the same reason `StreamSource`'s
 * is — a pipe splits wherever it likes, including through a multi-byte
 * character — but nothing else about the bytes is interpreted.
 *
 * ## The size limit is enforced after the whole body has been read
 *
 * Content is capped at 1 MiB of UTF-8 (D10). Standard input can exceed that,
 * and there are only two honest answers: send a truncated message, or refuse.
 * Truncating is disqualified — a message that arrives silently missing its
 * second half is worse than no message, and the recipient cannot tell — so this
 * refuses, with the actual size and the amount to cut.
 *
 * Reporting the actual size is why the whole stream is read rather than
 * abandoned at the first byte over. Memory is still bounded: once the total is
 * past the cap the chunks are dropped instead of kept, and only the byte count
 * keeps rising. So a caller who piped a 40 MiB file is told it was 40 MiB,
 * without this process ever holding 40 MiB.
 *
 * ## One idempotency key per invocation, reused by every attempt
 *
 * Plan §2's `clientMessageId` makes a retried send safe: the server answers a
 * repeat with the *original* message rather than writing a second one. That
 * safety is theoretical unless something actually retries with the same key, so
 * this command does — see {@link sendWithRetry}. The key is minted once, before
 * the first attempt, and the request object is built once and sent again
 * unmodified, which is what makes reuse structural rather than remembered.
 *
 * Retries are limited to {@link TransportError}: no response was produced at
 * all, so whether the message committed is genuinely unknown and asking again
 * is the only way to find out. A 5xx is *not* retried even though idempotency
 * would make it safe, because a 5xx is an answer — the server was reached and
 * said something — and a command that hammered a failing server would be
 * choosing for the operator.
 *
 * Across *processes*, `--client-message-id` is how the same guarantee is had: a
 * harness that crashed after sending and before reading the response can re-run
 * the identical command line and get the original message back rather than a
 * second one. The key is in the `--json` output for exactly that reason.
 *
 * ## What `--json` promises
 *
 * ```json
 * {
 *   "messageId": "msg_…",
 *   "conversationId": "cnv_…",
 *   "parentMessageId": null,
 *   "projectId": "prj_…",
 *   "clientMessageId": "0199…",
 *   "duplicate": false,
 *   "createdAt": "2026-09-08T12:00:00.000Z",
 *   "contentBytes": 18,
 *   "sender":    { "address": "@you/backend",   "agentId": "agt_…" },
 *   "recipient": { "address": "@alice/backend", "agentId": "agt_…" }
 * }
 * ```
 *
 * **Flat, and the two identifiers a harness came for are at the top level.**
 * The point of sending is to be able to follow the thread afterwards, and that
 * takes `messageId` (to reply to) and `conversationId` (to keep sending into).
 * `jq -r .conversationId` should not have to walk a nesting level invented for
 * tidiness.
 *
 * **The content is not echoed.** `agentchat agents` emits its wire rows
 * verbatim because a listing's rows *are* the answer; here the content is the
 * *input*, and a receipt names what was written rather than reproducing the
 * goods. Echoing it would also mean putting up to a megabyte back on stdout
 * immediately after reading it from stdin, which is a real cost for a caller
 * that piped a file. `contentBytes` is what the caller cannot recompute without
 * measuring UTF-8 themselves, and it is the number the size limit is expressed
 * in.
 *
 * **`duplicate` is reported, and is never a failure.** See below.
 *
 * ## A duplicate send is visible, and exits 0
 *
 * The server distinguishes a message it wrote (201) from the original of one
 * the sender had already sent (200). This command surfaces that as
 * `duplicate` in `--json` and as one dim line in the human rendering, and
 * changes nothing else: the exit code is 0, the message is the same message,
 * and it is delivered exactly once either way.
 *
 * Reporting it is not decoration. It is the only explanation for the two things
 * a caller would otherwise have to guess at — a `createdAt` that is minutes old
 * on a send that just returned, and whether the retry they issued was the
 * attempt that landed. Making it an error, or hiding it, would each answer one
 * of those wrongly. The human form puts it on stdout with the rest of the
 * receipt rather than on stderr, because it is a property of the result, not
 * commentary on the run.
 *
 * ## Three round trips, then the send
 *
 * `GET /projects` only when the project was named by slug; then `GET
 * /projects/:id/agents` and `GET /me` **in parallel**, because the roster
 * answers three questions at once — is the recipient there, which of these are
 * mine, and which one am I — and `/me` is what says which rows are the
 * caller's. The body is read last, so an unknown recipient fails before a
 * megabyte is pulled through a pipe.
 *
 * @module
 */

import { Buffer } from 'node:buffer';

import type { AgentChatClient, SendMessageOutcome } from '@agentchat/client';
import { TransportError } from '@agentchat/client';
import type {
  AgentId as AgentIdType,
  ProjectAgent,
  ProjectId,
  SendMessageRequest,
} from '@agentchat/protocol';
import {
  AGENT_NAME_PATTERN,
  AgentId,
  ConversationId,
  ErrorCode,
  MAX_CLIENT_MESSAGE_ID_LENGTH,
  MAX_MESSAGE_CONTENT_BYTES,
  MessageId,
  USERNAME_PATTERN,
  uuidv7,
} from '@agentchat/protocol';

import type { OptionSpecs } from '../args.js';
import type { ClientSeams } from '../client.js';
import { clientFor } from '../client.js';
import type { Command, CommandContext } from '../command.js';
import type { AgentIdentity, ResolvedAgent, ResolvedProject } from '../context.js';
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
import { PROGRAM } from '../version.js';

/** The usage line, quoted by every failure that is about how it was typed. */
const USAGE = 'send <@user/agent> <text|-> [--conversation <id>] [--reply-to <id>] [--json]';

/** How many times a send whose response was never seen is attempted in total. */
const ATTEMPTS = 3;

/**
 * How long to wait before each retry, in milliseconds.
 *
 * Short, and only two of them. This is not a reconnect policy — that is the
 * socket's job and has its own backoff — it is the couple of seconds that
 * covers a dropped connection or a server rolling over mid-request. Anything
 * longer would leave a harness blocked on a send that is not going to succeed.
 */
const RETRY_DELAYS_MS: readonly number[] = Object.freeze([250, 1000]);

/** The seams this command is built on; see `../client.ts`. */
export interface SendOverrides extends ClientSeams {
  /**
   * Waits between attempts.
   *
   * A seam so a test can prove the retry reuses its idempotency key without
   * spending the delay. Defaults to a real timer that gives up on interrupt.
   */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;

  /**
   * Mints the idempotency key when `--client-message-id` was not given.
   *
   * Defaults to {@link uuidv7}. A seam because a test that asserts the same key
   * reached the server twice has to know what it was.
   */
  readonly newClientMessageId?: () => string;
}

/** `--project`, `--agent`, and this command's own three. */
const SEND_OPTIONS: OptionSpecs = Object.freeze({
  ...CONTEXT_OPTIONS,
  conversation: {
    type: 'string',
    placeholder: '<id>',
    description: 'send into an existing conversation you are party to',
  },
  'reply-to': {
    type: 'string',
    placeholder: '<id>',
    description: 'reply to a message, inheriting its conversation',
  },
  'client-message-id': {
    type: 'string',
    placeholder: '<id>',
    description: 'the idempotency key to send under, so a re-run cannot duplicate',
  },
});

/** Who a message is addressed to, as the command line named them. */
export type RecipientReference =
  | { readonly kind: 'handle'; readonly username: string; readonly agent: string }
  | { readonly kind: 'id'; readonly id: AgentIdType };

/**
 * Reads `@alice/backend`, or a bare agent id.
 *
 * The handle is the documented form (PRD §16) and the one `agentchat agents`
 * prints. An id is accepted as well because that same command emits one in its
 * `--json`, and a harness that has it should not have to reassemble a handle
 * from two other fields in order to use it — reassembling is where it would get
 * it wrong.
 *
 * @param raw - The first positional argument.
 * @returns Who to send to.
 * @throws {UsageError} When it is neither form. The message names the shape and
 *   the command that lists real ones.
 */
export function parseRecipient(raw: string): RecipientReference {
  if (AgentId.is(raw)) {
    return { kind: 'id', id: raw };
  }

  const match = /^@([^/]+)\/(.+)$/.exec(raw);
  const username = match?.[1];
  const agent = match?.[2];
  if (
    username !== undefined &&
    agent !== undefined &&
    USERNAME_PATTERN.test(username) &&
    AGENT_NAME_PATTERN.test(agent)
  ) {
    return { kind: 'handle', username, agent };
  }

  throw new UsageError(
    `\`${truncate(raw)}\` is not an agent address — write it as \`@user/agent\`, for example \`@alice/backend\`.`,
    {
      hint: `\`${PROGRAM} agents\` lists every agent in the project with the address to send to. Usage: ${PROGRAM} ${USAGE}`,
    },
  );
}

/** How a discovery row is addressed. Mirrors `./agents.ts`'s `addressOf`. */
function addressOf(row: ProjectAgent): string {
  return `@${row.owner.username}/${row.agent.name}`;
}

/**
 * Finds the recipient in the project's roster.
 *
 * @param rows - Every agent in the project, as discovery listed them.
 * @param reference - Who the caller named.
 * @param project - The project, for the message.
 * @returns The row.
 * @throws {CliError} `NOT_FOUND` naming `agentchat agents` — see the module
 *   note. When the owner exists but the agent does not, their agents are
 *   listed, because that is the correction the reader is about to look up.
 */
export function requireRecipient(
  rows: readonly ProjectAgent[],
  reference: RecipientReference,
  project: ResolvedProject,
): ProjectAgent {
  const where = describeProject(project);

  if (reference.kind === 'id') {
    const byId = rows.find((row) => row.agent.id === reference.id);
    if (byId !== undefined) {
      return byId;
    }
    throw unknownRecipient(`\`${reference.id}\``, where, null);
  }

  const named = `\`@${reference.username}/${reference.agent}\``;
  const byHandle = rows.find(
    (row) => row.owner.username === reference.username && row.agent.name === reference.agent,
  );
  if (byHandle !== undefined) {
    return byHandle;
  }

  // The two failures read very differently to whoever typed it: a name they got
  // wrong, versus a person who is in the project but has no agent by that name.
  const theirs = rows
    .filter((row) => row.owner.username === reference.username)
    .map((row) => addressOf(row));
  throw unknownRecipient(named, where, theirs.length === 0 ? null : theirs);
}

/**
 * The "no such recipient" failure, in the terms of the discovery command.
 *
 * Never a raw `NOT_FOUND` from the server, and never a bare "not found": the
 * first sentence names `agentchat agents`, so a reader who gets no further than
 * the `error:` line still knows what to type next.
 *
 * @param named - How the recipient was written, already quoted.
 * @param where - The project, as a human names it.
 * @param theirs - The owner's other agents here, or `null` when the owner has
 *   none — which includes the case where there is no such owner.
 * @returns The error to throw.
 */
function unknownRecipient(
  named: string,
  where: string,
  theirs: readonly string[] | null,
): CliError {
  const alternatives =
    theirs === null
      ? ''
      : ` That owner has ${theirs.length === 1 ? 'one agent' : `${String(theirs.length)} agents`} there: ${theirs.join(', ')}.`;
  return new CliError(
    ErrorCode.NOT_FOUND,
    `${named} is not an agent in ${where} — run \`${PROGRAM} agents\` to see who is.`,
    {
      hint: `${alternatives === '' ? '' : `${alternatives.trim()} `}\`${PROGRAM} agents\` lists everyone's agents in the project, grouped by owner, each with the address this command takes.`,
    },
  );
}

/**
 * The agent this invocation sends as, as an identifier.
 *
 * `resolveAgent` answers *which* agent by the documented precedence and may
 * answer with only a name or only an id (`../context.ts`). Turning either into
 * an id needs the project's roster, which this command has already fetched — so
 * the single-agent shortcut is enabled from rows already in hand rather than
 * from a fourth round trip.
 *
 * @param resolved - What context resolution chose.
 * @param own - The caller's own agents in this project.
 * @param project - The project, for the messages.
 * @returns The sender's agent id and address.
 * @throws {CliError} `AGENT_NOT_IN_PROJECT` when the chosen agent is not one of
 *   the caller's here. The remedy differs by where the choice came from: a
 *   stale stored default is fixed with `agent use`, a mistyped `--agent` with
 *   `agent join` or a different name.
 */
export function requireSender(
  resolved: ResolvedAgent,
  own: readonly ProjectAgent[],
  project: ResolvedProject,
): ProjectAgent {
  const match = own.find((row) =>
    resolved.id !== null ? row.agent.id === resolved.id : row.agent.name === resolved.name,
  );
  if (match !== undefined) {
    return match;
  }

  const named = resolved.name ?? resolved.id ?? '';
  const where = describeProject(project);
  const yours = own.map((row) => row.agent.name);
  const listing =
    yours.length === 0
      ? `You have no agents in ${where}.`
      : `Yours there ${yours.length === 1 ? 'is' : 'are'}: ${yours.join(', ')}.`;

  // A stored default that no longer resolves is its own failure: nothing the
  // caller typed is wrong, so telling them to check their spelling is useless.
  if (resolved.source === 'user-config') {
    return neverReturns(
      new CliError(
        ErrorCode.AGENT_NOT_IN_PROJECT,
        `Your default agent for ${where} (\`${named}\`) is not in that project any more — run \`${PROGRAM} agent use <name>\` to choose another.`,
        {
          hint: `${listing} It came from ${resolved.origin}. \`${PROGRAM} agent list\` shows every agent you own.`,
        },
      ),
    );
  }

  return neverReturns(
    new CliError(
      ErrorCode.AGENT_NOT_IN_PROJECT,
      `\`${truncate(named)}\` is not one of your agents in ${where} — run \`${PROGRAM} agent join ${AGENT_NAME_PATTERN.test(named) ? named : '<name>'}\` to add it.`,
      {
        hint: `${listing} It came from ${resolved.origin}. \`${PROGRAM} agent list\` shows every agent you own, and \`${PROGRAM} agents\` shows everyone's in this project.`,
      },
    ),
  );
}

/**
 * Throws, in an expression position.
 *
 * `requireSender` has two failure paths that differ only in their message, and
 * writing them as `throw` statements would leave the compiler unable to see
 * that the function ends there. This keeps both as a single `return`.
 *
 * @param error - The failure.
 * @returns Never.
 * @throws The error it was given.
 */
function neverReturns(error: CliError): never {
  throw error;
}

/**
 * The message body: the second positional, or all of standard input.
 *
 * @param context - The command context.
 * @param spec - The second positional argument. `-` means standard input.
 * @returns The content, exactly as it was given.
 * @throws {CliError} `PAYLOAD_TOO_LARGE` when it exceeds 1 MiB of UTF-8.
 */
async function readBody(context: CommandContext, spec: string): Promise<string> {
  const content = spec === '-' ? await readStandardInput(context) : spec;
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_MESSAGE_CONTENT_BYTES) {
    throw tooLarge(bytes, spec === '-');
  }
  return content;
}

/**
 * Reads standard input to the end, verbatim.
 *
 * See the module note for why this does not go through `StreamSource` and why
 * nothing is trimmed. The one thing it does interpret is the encoding: chunks
 * are decoded with a streaming decoder so a multi-byte character split across a
 * pipe boundary survives.
 *
 * Memory is bounded at roughly the content limit. Once the byte count is past
 * it the message is going to be refused, so the text is dropped and only the
 * count keeps rising — which is what lets the failure report the true size of a
 * body far larger than this process could hold.
 *
 * @param context - The command context, for the descriptor and the interrupt.
 * @returns Everything standard input produced.
 * @throws {CliError} `PAYLOAD_TOO_LARGE` when the stream exceeds the limit.
 */
async function readStandardInput(context: CommandContext): Promise<string> {
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytes = 0;
  let overflowed = false;

  for await (const chunk of context.env.stdin) {
    if (context.signal.aborted) {
      break;
    }
    const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
    if (bytes > MAX_MESSAGE_CONTENT_BYTES) {
      // Past the point of no return. Keep counting, stop keeping.
      overflowed = true;
      parts.length = 0;
      continue;
    }
    parts.push(text);
  }
  // Flush whatever the decoder held: a truncated multi-byte sequence becomes a
  // replacement character rather than vanishing.
  const tail = decoder.decode();
  if (!overflowed && tail !== '') {
    parts.push(tail);
  }

  if (overflowed) {
    throw tooLarge(bytes, true);
  }
  return parts.join('');
}

/**
 * The content-limit failure, with the numbers a caller can act on.
 *
 * @param bytes - How large the body actually was, in bytes of UTF-8.
 * @param fromStdin - Whether it came from standard input, which changes the
 *   remedy: you cannot shorten an argument you did not type.
 * @returns The error to throw.
 */
function tooLarge(bytes: number, fromStdin: boolean): CliError {
  const over = bytes - MAX_MESSAGE_CONTENT_BYTES;
  return new CliError(
    ErrorCode.PAYLOAD_TOO_LARGE,
    `The message is ${bytes.toLocaleString('en-US')} bytes of UTF-8; the limit is ${MAX_MESSAGE_CONTENT_BYTES.toLocaleString('en-US')} (1 MiB). Cut ${over.toLocaleString('en-US')} bytes.`,
    {
      hint: fromStdin
        ? 'Nothing was sent — a truncated message is worse than none, so the whole body is refused. Send a summary and a link to the full content, or split it across several messages.'
        : 'Nothing was sent. Send a shorter message, or a link to the content.',
    },
  );
}

/**
 * Reads and validates a branded identifier passed as an option.
 *
 * @param raw - The flag's value, if it was given.
 * @param flag - The flag's name, for the message.
 * @param kind - The identifier operations, for the prefix and the check.
 * @param what - What the identifier names, for the message.
 * @returns The identifier, or `undefined` when the flag was absent.
 * @throws {UsageError} When the value is not an identifier of that kind.
 */
function optionalId<T extends string>(
  raw: string | undefined,
  flag: string,
  kind: { readonly prefix: string; is(value: unknown): value is T },
  what: string,
): T | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (kind.is(raw)) {
    return raw;
  }
  throw new UsageError(
    `\`--${flag}\` is \`${truncate(raw)}\`, which is not ${what} identifier (\`${kind.prefix}<uuidv7>\`).`,
    {
      hint: `\`${PROGRAM} send --json\` reports the \`messageId\` and \`conversationId\` of every message it sends; those are the values to pass here. Usage: ${PROGRAM} ${USAGE}`,
    },
  );
}

/**
 * The idempotency key for this invocation.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns The key. Minted once; every attempt reuses it.
 * @throws {UsageError} When `--client-message-id` was given something the
 *   server cannot store.
 */
function clientMessageIdFor(context: CommandContext, overrides: SendOverrides): string {
  const given = context.args.value('client-message-id');
  if (given === undefined) {
    return (overrides.newClientMessageId ?? uuidv7)();
  }
  if (given === '' || given.length > MAX_CLIENT_MESSAGE_ID_LENGTH) {
    throw new UsageError(
      `\`--client-message-id\` must be between 1 and ${String(MAX_CLIENT_MESSAGE_ID_LENGTH)} characters; got ${String(given.length)}.`,
      {
        hint: 'It is opaque to the server and only has to be unique per sending agent. Omit it and one is generated for you.',
      },
    );
  }
  return given;
}

/**
 * Sends, retrying a send whose response never arrived.
 *
 * The request is built by the caller and passed in whole, so every attempt
 * carries the identical `clientMessageId` by construction rather than by a line
 * somebody has to remember not to move. That is the entire point: the server's
 * idempotency guarantee is worth nothing if the retry that exercises it mints a
 * new key.
 *
 * @param client - The client to send with.
 * @param request - The send, complete and unchanging.
 * @param context - The command context, for the interrupt and for stderr.
 * @param overrides - Test seams.
 * @returns The committed message, and whether this process wrote it.
 * @throws {TransportError} When every attempt failed to reach the server.
 */
async function sendWithRetry(
  client: AgentChatClient,
  request: SendMessageRequest,
  context: CommandContext,
  overrides: SendOverrides,
): Promise<SendMessageOutcome> {
  const wait = overrides.sleep ?? sleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await client.messages.send(request, { signal: context.signal });
    } catch (error) {
      // Only a failure to reach the server at all. A 4xx or 5xx is an answer,
      // and answering it by asking again would be this command deciding on the
      // operator's behalf. See the module note.
      if (!(error instanceof TransportError) || attempt >= ATTEMPTS || context.signal.aborted) {
        throw error;
      }
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 0;
      context.log.warn(
        `The server could not be reached (attempt ${String(attempt)} of ${String(ATTEMPTS)}); retrying under the same client message id, so this cannot send twice.`,
      );
      await wait(delay, context.signal);
    }
  }
}

/**
 * Waits, or stops waiting when the command is interrupted.
 *
 * @param milliseconds - How long to wait.
 * @param signal - The interrupt signal.
 * @returns A promise that resolves after the delay, or as soon as the signal
 *   fires — the caller checks the signal itself and does not need to know
 *   which.
 */
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort(): void {
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Everything the receipt is rendered from. */
export interface SendReceipt {
  /** The committed message and whether this call wrote it. */
  readonly outcome: SendMessageOutcome;

  /** The idempotency key it was sent under. */
  readonly clientMessageId: string;

  /** The sender's address, `@you/backend`. */
  readonly sender: string;

  /** The recipient's address, `@alice/backend`. */
  readonly recipient: string;

  /** The content's size in bytes of UTF-8. */
  readonly contentBytes: number;
}

/**
 * The result of a send, in both representations.
 *
 * @param receipt - What was sent, and where it landed.
 * @returns The view. See the module note for what the JSON promises.
 */
export function sendView(receipt: SendReceipt): View {
  const { message } = receipt.outcome;
  const json: JsonValue = {
    messageId: message.id,
    conversationId: message.conversationId,
    parentMessageId: message.parentMessageId,
    projectId: message.projectId,
    clientMessageId: receipt.clientMessageId,
    duplicate: receipt.outcome.duplicate,
    createdAt: message.createdAt,
    contentBytes: receipt.contentBytes,
    sender: { address: receipt.sender, agentId: message.senderAgentId },
    recipient: { address: receipt.recipient, agentId: message.recipientAgentId },
  };

  return view(json, (writer) => {
    writer.line(`Sent to ${writer.style.cyan(receipt.recipient)}`);
    writer.fields([
      ['from', receipt.sender],
      ['message', message.id],
      ['conversation', message.conversationId],
      ['in reply to', message.parentMessageId],
    ]);

    if (receipt.outcome.duplicate) {
      writer.blank();
      writer.line(
        writer.style.dim(
          'This message had already been sent under the same client message id; the original is unchanged and was not sent again.',
        ),
      );
    }

    writer.blank();
    writer.line(
      writer.style.dim(
        `Continue the thread with \`${PROGRAM} send ${receipt.recipient} --conversation ${message.conversationId} "…"\`.`,
      ),
    );
  });
}

/**
 * Turns a project reference into an identifier.
 *
 * Only when it is not already known. A repository configuration records the id
 * (T-205), so the common case makes no request at all; `--project payments`
 * costs one, because a slug is not an id and this is the only endpoint that
 * turns one into the other.
 *
 * @param client - The client to ask.
 * @param project - The resolved project.
 * @param signal - The interrupt signal.
 * @returns The project's identifier.
 * @throws {CliError} `NOT_FOUND` when the caller is in no such project.
 */
async function projectIdFor(
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

/**
 * Renders an untrusted value for a message, bounded.
 *
 * @param value - The value.
 * @returns It, truncated at 48 characters.
 */
function truncate(value: string): string {
  return value.length > 48 ? `${value.slice(0, 48)}…` : value;
}

/**
 * Runs `agentchat send`.
 *
 * @param context - The command context.
 * @param overrides - Test seams.
 * @returns A promise that resolves once the receipt has been written.
 */
async function send(context: CommandContext, overrides: SendOverrides): Promise<void> {
  const recipientReference = parseRecipient(
    context.args.required(0, 'the agent to send to', `${PROGRAM} ${USAGE}`),
  );
  const bodySpec = context.args.required(
    1,
    'the message text (or `-` for standard input)',
    `${PROGRAM} ${USAGE}`,
  );

  const conversationId = optionalId(
    context.args.value('conversation'),
    'conversation',
    ConversationId,
    'a conversation',
  );
  const parentMessageId = optionalId(
    context.args.value('reply-to'),
    'reply-to',
    MessageId,
    'a message',
  );
  const clientMessageId = clientMessageIdFor(context, overrides);

  const client = await clientFor(context, overrides);
  const project = await resolveProject(contextRequestFor(context));
  const projectId = await projectIdFor(client, project, context.signal);

  // One request for the whole roster, and the account it has to be read
  // against, at the same time. See the module note.
  const [roster, me] = await Promise.all([
    client.projects.listAgents(projectId, { signal: context.signal }),
    client.auth.me({ signal: context.signal }),
  ]);

  const recipient = requireRecipient(roster.items, recipientReference, project);
  const own = roster.items.filter((row) => row.owner.id === me.id);
  const identities: readonly AgentIdentity[] = own.map((row) => ({
    id: row.agent.id,
    name: row.agent.name,
  }));
  const sender = requireSender(
    await resolveAgent(
      project,
      contextRequestFor(context, { agents: () => Promise.resolve(identities) }),
    ),
    own,
    project,
  );

  // Last, so an unknown recipient fails before a megabyte is read.
  const content = await readBody(context, bodySpec);
  if (content === '') {
    context.log.warn(
      bodySpec === '-'
        ? 'Standard input was empty, so an empty message is being sent.'
        : 'The message body is empty.',
    );
  }

  const request: SendMessageRequest = {
    projectId,
    senderAgentId: sender.agent.id,
    recipientAgentId: recipient.agent.id,
    content,
    clientMessageId,
    ...(conversationId === undefined ? {} : { conversationId }),
    // Both are passed through when both were given. The server checks that they
    // agree and refuses when they do not, which is a better answer than this
    // command guessing which one the caller meant.
    ...(parentMessageId === undefined ? {} : { parentMessageId }),
  };

  const outcome = await sendWithRetry(client, request, context, overrides);

  await context.emit(
    sendView({
      outcome,
      clientMessageId,
      sender: addressOf(sender),
      recipient: addressOf(recipient),
      contentBytes: Buffer.byteLength(content, 'utf8'),
    }),
  );
}

/**
 * Builds `agentchat send`.
 *
 * @param overrides - Test seams; empty in production.
 * @returns The command.
 */
export function createSendCommand(overrides: SendOverrides = {}): Command {
  return {
    kind: 'command',
    name: 'send',
    summary: 'send a message to an agent in this project',
    usage: USAGE,
    options: SEND_OPTIONS,
    positionals: { min: 2, max: 2 },
    details: [
      'The address is the one `agentchat agents` prints: `@user/agent`. The body is either a single argument or `-`, which reads the whole of standard input verbatim — no trailing newline is stripped and nothing is trimmed, so a generated document arrives as it was produced.',
      'Every send carries a client message id, generated per invocation. A send whose response never arrives is retried under the same id, and the server answers a repeat with the original message rather than writing a second one. Pass `--client-message-id` to extend that guarantee across separate runs of the command.',
      "`--reply-to <message>` inherits the parent's conversation; `--conversation <id>` sends into a thread you are already party to. Passing both is allowed and is checked by the server, which refuses them when they disagree.",
      '`--json` emits one document carrying `messageId`, `conversationId`, `clientMessageId` and `duplicate`. Content is not echoed back; `contentBytes` reports its size.',
      'To send text that begins with a hyphen, put `--` before it: `agentchat send @alice/backend -- --json is not a flag here`.',
    ],

    /** @inheritdoc */
    run(context: CommandContext): Promise<void> {
      return send(context, overrides);
    },
  };
}

/** `agentchat send`. */
export const sendCommand: Command = createSendCommand();
