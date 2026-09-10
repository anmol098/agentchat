/**
 * The WebSocket wire vocabulary: frame schemas, close codes, and the decoder
 * that turns arriving bytes into one of three outcomes.
 *
 * Plan §4.1 and §4.2 fix the frames. This module is those two lists made
 * executable, plus the one rule that governs everything else here:
 *
 * ## The additive-only rule (Plan §12.4)
 *
 * A protocol change within a major version may add an optional field or a new
 * frame type, and nothing else. Both sides ignore what they do not recognise.
 * That is not politeness, it is the difference between shipping a client and
 * coordinating an upgrade: a server that disconnected a newer client for
 * sending a field it had never heard of would make every protocol addition a
 * flag day across every machine running `agentchat listen`.
 *
 * Two mechanisms implement it, and neither is incidental:
 *
 * - **Unknown fields are stripped.** Every frame schema below is a plain
 *   `z.object`, which in zod 4 drops keys it was not told about. Not
 *   `z.strictObject`, which would reject them. A reviewer changing one of these
 *   to `strictObject` to "tighten validation" would be breaking the rule.
 * - **Unknown frame types are ignored.** {@link decodeFrame} answers
 *   {@link IgnoredFrame} for a `type` it does not know, and the handler drops
 *   it. It does not close, and it does not answer an error — a frame this
 *   server has no opinion about is not a fault to report.
 *
 * The rule stops at *known* types: a frame that says `"type":"hello"` and then
 * omits `sessionId` is not a newer client, it is a broken one, and it is
 * refused. Forward compatibility means unrecognised, not malformed.
 *
 * ## `type` is a transport operation and never a meaning
 *
 * There are five frame types in each direction's list and there will never be a
 * sixth carrying anything about what a message is *for* — no `type: "review"`,
 * no `type: "task"`, no `type: "handoff"`. PRD §34/§35 and Plan §4.2 make this
 * the product's central constraint: the server routes bytes between agents and
 * has no view about their content. A semantic frame type would be the server
 * forming one. Adding a transport operation (a new acknowledgement mode, a
 * resume token) is an ordinary additive change; adding a meaning is not a
 * protocol change at all, it is a different product.
 *
 * ## Close codes
 *
 * The table lives in `@stackgrid/protocol`'s `websocket.ts` and is re-exported
 * below (T-052). It is one wire vocabulary; it used to be transcribed here and
 * again in `packages/client`, and it drifted twice. `docs/protocol.md` §9.6 is
 * the human-readable version, and `../../tests/protocol-doc.test.ts` compares
 * the two in both directions.
 *
 * What belongs *here* is what the codes mean for this server, which the shared
 * table does not decide:
 *
 * Close codes and contract codes are different layers and do not have to agree
 * in cardinality. Three distinct close codes share `PROTOCOL_VIOLATION`,
 * because a client's *remedy* differs — fix your JSON, send `hello` first,
 * populate the field — while the category it reports to its operator does not.
 * The functions below are where each close code is paired with the contract
 * code its `error` frame carries.
 *
 * **`BACKLOG_UNREAD` is the one 44xx code that names no fault** (T-048). It sits
 * in the private-use block because the condition is this server's own, and the
 * mnemonic still reads — 429 is the status a reader already associates with
 * back-pressure — but nothing the client *sent* was wrong, so no code in the
 * frozen set fits without lying: `PROTOCOL_VIOLATION` blames a frame that was
 * fine, `PAYLOAD_TOO_LARGE` blames the sender, `INTERNAL` sends an operator
 * hunting a bug that is not there. It therefore takes `—` in the contract
 * column exactly as 1000 does, and sends no `error` frame — which is also the
 * only sensible thing to do for a socket being closed because bytes written to
 * it are not being read. It has no builder below for that reason.
 *
 * It is separate from 1000 because a close code is the only part of a close a
 * client can branch on, and the two remedies are opposite: 1000 means somebody
 * else restarted and there is nothing to fix locally, while this one means the
 * consumer stopped reading and will be dropped again on the next connection
 * unless it is fixed (`docs/protocol.md` §9.8). The cause did travel in the
 * close frame's reason, but a reason is prose — outside the additive-only rule,
 * outside the frozen vocabulary, and not something a structured consumer sees:
 * `agentchat listen --json` reports the closure's `code` and not its `reason`.
 * That is the same admission test T-017 applied to the error set, reaching the
 * same answer.
 *
 * `SESSION_INVALID` maps to HTTP 500 in `../errors.ts`. That is deliberate and
 * documented there: it is a reason for closing a socket, not an answer to a
 * request, so an HTTP route raising it would be a server bug. Nothing in this
 * module goes through the HTTP mapping.
 *
 * @module
 */

import {
  type AgentId,
  CloseCode,
  type CloseCodeValue,
  ErrorCode,
  MessageId,
  type ProjectId,
  SessionId,
  type UserId,
} from '@stackgrid/protocol';
import { z } from 'zod';
import { BODY_LIMIT_BYTES } from '../config.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * The largest frame this server will accept, in bytes.
 *
 * Imported from the HTTP body limit rather than restated, because Plan §2 fixes
 * them at the same number for the same reason — a 1 MiB message body (D10) plus
 * its JSON envelope has to fit through either door. Two literals would be two
 * numbers, and the day somebody changed one, a message that posted over HTTP
 * would be undeliverable over the socket, or the reverse.
 *
 * The transport's own `maxPayload` should be set to this same constant by
 * whoever wires the socket up. That is defence in depth, not the mechanism: a
 * transport-level limit closes with RFC 6455's 1009, which tells a client
 * nothing this project has documented, so the check that matters is the one in
 * {@link decodeFrame} answering {@link CloseCode.FRAME_TOO_LARGE}.
 */
export const MAX_FRAME_BYTES = BODY_LIMIT_BYTES;

/**
 * The longest close reason RFC 6455 permits, in bytes of UTF-8.
 *
 * The control frame carrying a close is capped at 125 bytes of payload, two of
 * which are the status code. A reason over the limit makes the transport throw
 * as the socket is closing — the least recoverable moment there is — so
 * {@link closeReasonText} truncates instead.
 */
export const MAX_CLOSE_REASON_BYTES = 123;

/**
 * The longest client identifier a `hello` may carry, in characters.
 *
 * `X-AgentChat-Client: agentchat/1.2.3` (Plan §12.4) and room for a longer
 * product name. Bounded because it is logged: an unbounded string from an
 * unauthenticated-until-just-now peer is a log-flooding primitive.
 */
const MAX_CLIENT_IDENTIFIER_LENGTH = 128;

// ---------------------------------------------------------------------------
// Close codes
// ---------------------------------------------------------------------------

export type { CloseCodeValue };
/**
 * Every code this server closes a socket with, and one of its values.
 *
 * Re-exported from `@stackgrid/protocol` rather than declared here (T-052).
 * The table is one wire vocabulary that both halves read, and it had been
 * transcribed into each of them; see that module for why the shared home is
 * also what puts it under `pnpm protocol:check`.
 *
 * Re-exported rather than left to be imported directly, because every caller in
 * this half already reaches for it through this module and the close reasons
 * below are built from it here.
 */
export { CloseCode };

/**
 * Why a socket is being closed: what the client is told, and what the operator
 * is told.
 *
 * The split is the same one `../plugins/auth.ts` draws for a 401 and
 * `../services/sessions.ts` draws for a missing session. `message` is written
 * for the client and names a remedy; `detail` names the actual cause and is
 * never sent, because the causes a socket refuses for include "that session id
 * belongs to somebody else", and a client able to tell that apart from "no such
 * session" has an identifier oracle.
 */
export interface CloseReason {
  /** The WebSocket close code. */
  readonly code: CloseCodeValue;

  /** The contract code, for the `error` frame sent before the close. */
  readonly error: ErrorCode;

  /** Client-facing. Sent in the `error` frame and as the close reason. */
  readonly message: string;

  /** Operator-facing. Logged, never sent. */
  readonly detail: string;
}

/** Builds a {@link CloseReason}. Purely a shorthand; see that type for the split. */
function closing(
  code: CloseCodeValue,
  error: ErrorCode,
  message: string,
  detail: string,
): CloseReason {
  return { code, error, message, detail };
}

/**
 * The upgrade carried no usable access token.
 *
 * @param detail - What was actually wrong. Logged, never sent.
 * @returns The close reason.
 */
export function unauthenticated(detail: string): CloseReason {
  return closing(
    CloseCode.UNAUTHENTICATED,
    ErrorCode.AUTH_REQUIRED,
    'This socket requires a valid access token. Sign in again with: agentchat login',
    detail,
  );
}

/**
 * `hello` named a session this socket may not bind to.
 *
 * One message for every cause — unknown id, somebody else's id, an ended or
 * stale one — following `SESSION_FAILURE_MESSAGES` in
 * `../services/sessions.ts`. Session ids are printed by `listen`, pasted into
 * bug reports and kept in shell history; a message that distinguished the
 * causes would turn the handshake into a way to test whether an id exists.
 *
 * @param detail - Which cause it actually was. Logged, never sent.
 * @returns The close reason.
 */
export function sessionInvalid(detail: string): CloseReason {
  return closing(
    CloseCode.SESSION_INVALID,
    ErrorCode.SESSION_INVALID,
    'No usable session with that id. Start a new listener with: agentchat listen --runtime <name>',
    detail,
  );
}

/**
 * A known frame arrived where the handshake does not allow it.
 *
 * @param detail - Which frame, and in which position. Logged, never sent.
 * @returns The close reason.
 */
export function outOfOrder(detail: string): CloseReason {
  return closing(
    CloseCode.FRAME_OUT_OF_ORDER,
    ErrorCode.PROTOCOL_VIOLATION,
    'The first frame on a socket must be hello, and hello may only be sent once.',
    detail,
  );
}

/**
 * The server failed while handling a frame.
 *
 * @param detail - The underlying failure. Logged, never sent.
 * @returns The close reason.
 */
export function internalFailure(detail: string): CloseReason {
  return closing(
    CloseCode.INTERNAL_ERROR,
    ErrorCode.INTERNAL,
    'The server failed to handle this connection.',
    detail,
  );
}

/**
 * Trims a close reason to what the transport will carry.
 *
 * Truncation is by byte and stops at a code point boundary: a string cut
 * mid-sequence is not UTF-8, and a close frame whose reason is not UTF-8 is a
 * protocol error on the way out of a protocol error.
 *
 * @param reason - The reason being reported.
 * @returns At most {@link MAX_CLOSE_REASON_BYTES} bytes of its message.
 */
export function closeReasonText(reason: CloseReason): string {
  const { message } = reason;
  if (Buffer.byteLength(message, 'utf8') <= MAX_CLOSE_REASON_BYTES) {
    return message;
  }

  // `toString` on a slice of a UTF-8 buffer replaces a partial code point at
  // the end with U+FFFD, which is one to three bytes wider than the bytes it
  // replaced. Trimming the last character afterwards is what keeps the result
  // inside the limit.
  const truncated = Buffer.from(message, 'utf8')
    .subarray(0, MAX_CLOSE_REASON_BYTES)
    .toString('utf8');

  return Buffer.byteLength(truncated, 'utf8') <= MAX_CLOSE_REASON_BYTES
    ? truncated
    : [...truncated].slice(0, -1).join('');
}

// ---------------------------------------------------------------------------
// Client → server frames (Plan §4.1)
// ---------------------------------------------------------------------------

/**
 * The first frame on every socket. Binds it to a registered session.
 *
 * `sessionId` is the only source of the session, and deliberately so. The
 * access token has an optional `sid` claim, but T-302 established that it does
 * not survive a refresh: a listener whose token was renewed mid-run carries a
 * token whose session claim is absent or stale, and a handshake that trusted it
 * would refuse exactly the long-running listeners this system exists for. The
 * claim is not consulted here at all.
 *
 * `client` is the `X-AgentChat-Client` value of Plan §12.4 — optional, because
 * it was not in the §4.1 frame and an older client will not send it, which is
 * the additive rule applied to this module's own schema.
 */
export const HelloFrameSchema = z.object({
  type: z.literal('hello'),
  sessionId: SessionId.schema,
  client: z.string().max(MAX_CLIENT_IDENTIFIER_LENGTH).optional(),
});

/** A parsed `hello`. */
export type HelloFrame = z.infer<typeof HelloFrameSchema>;

/**
 * Acknowledges one delivered message, so the inbox stops replaying it.
 *
 * Acted on by T-308; this module only guarantees the shape.
 */
export const AckFrameSchema = z.object({
  type: z.literal('ack'),
  messageId: MessageId.schema,
});

/** A parsed `ack`. */
export type AckFrame = z.infer<typeof AckFrameSchema>;

/** Liveness from the client's side. Answered with `pong`. */
export const PingFrameSchema = z.object({
  type: z.literal('ping'),
});

/** A parsed `ping`. */
export type PingFrame = z.infer<typeof PingFrameSchema>;

/** The members of the client frame union, in one place so nothing lists them twice. */
const CLIENT_FRAME_SCHEMAS = [HelloFrameSchema, AckFrameSchema, PingFrameSchema] as const;

/** Every frame a client may send. */
export const ClientFrameSchema = z.discriminatedUnion('type', CLIENT_FRAME_SCHEMAS);

/** A parsed client frame. */
export type ClientFrame = z.infer<typeof ClientFrameSchema>;

/**
 * The `type` values this server knows how to act on.
 *
 * Anything else is a frame from a newer client and is ignored. This set is what
 * "unknown" is measured against, and it is read off the schemas rather than
 * written out again: a fourth frame type added to the union without being added
 * here would be silently ignored forever, which is the one failure mode of the
 * additive rule that is genuinely hard to notice.
 */
export const CLIENT_FRAME_TYPES: ReadonlySet<string> = new Set(
  CLIENT_FRAME_SCHEMAS.map((schema) => schema.shape.type.value),
);

// ---------------------------------------------------------------------------
// Server → client frames (Plan §4.2)
// ---------------------------------------------------------------------------

/** The handshake is complete and `pending` messages were replayed before this. */
export interface ReadyFrame {
  readonly type: 'ready';
  readonly sessionId: SessionId;
  readonly pending: number;
}

/**
 * One delivered message.
 *
 * `message` is typed `unknown` on purpose. Its fields are the message contract
 * (Plan §4.2), which belongs to the messages service and its own task; naming
 * them here would be this module guessing at a shape another one owns, and the
 * two would drift the first time either changed. This module owns the envelope
 * — that a delivery is a frame whose `type` is `message` and whose payload sits
 * under `message` — and nothing more.
 */
export interface MessageFrame {
  readonly type: 'message';
  readonly message: unknown;
}

/** The answer to a client `ping`. */
export interface PongFrame {
  readonly type: 'pong';
}

/**
 * Something went wrong. Sent immediately before a close in every case this
 * module produces, so a client that never reads close codes still learns why.
 */
export interface ErrorFrame {
  readonly type: 'error';
  readonly code: ErrorCode;
  readonly message: string;
}

/** Every frame the server may send. */
export type ServerFrame = ReadyFrame | MessageFrame | PongFrame | ErrorFrame;

/**
 * Builds the `error` frame for a close reason.
 *
 * Only {@link CloseReason.message} crosses the wire; `detail` stays in the log.
 *
 * @param reason - Why the socket is closing.
 * @returns The frame to send before closing.
 */
export function errorFrame(reason: CloseReason): ErrorFrame {
  return { type: 'error', code: reason.error, message: reason.message };
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** A frame this server knows and accepts. */
export interface AcceptedFrame {
  readonly kind: 'frame';
  readonly frame: ClientFrame;
}

/**
 * A frame with a `type` this server has never heard of.
 *
 * Not an error, and not answered: this is the additive-only rule doing its job.
 * The type is carried so the handler can log it once, which is how an operator
 * finds out a newer client is talking to an older server.
 */
export interface IgnoredFrame {
  readonly kind: 'ignored';
  readonly type: string;
}

/** A frame that costs the socket its connection. */
export interface RejectedFrame {
  readonly kind: 'rejected';
  readonly reason: CloseReason;
}

/** What arriving bytes turned out to be. */
export type DecodedFrame = AcceptedFrame | IgnoredFrame | RejectedFrame;

/** The bytes a transport hands over for one message. */
export type RawFrame = string | Uint8Array;

/** Decoder that refuses a byte sequence which is not valid UTF-8. */
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Rejection shorthand. */
function rejected(reason: CloseReason): RejectedFrame {
  return { kind: 'rejected', reason };
}

/** A frame that is not JSON, or not JSON this protocol could ever mean. */
function malformed(detail: string): RejectedFrame {
  return rejected(
    closing(
      CloseCode.FRAME_MALFORMED,
      ErrorCode.PROTOCOL_VIOLATION,
      'Every frame must be a JSON object with a string type field.',
      detail,
    ),
  );
}

/**
 * Turns one arriving message into an outcome.
 *
 * The order of the checks is the design. Size first, before anything walks the
 * bytes, so an oversize frame is refused without being parsed. Then UTF-8, then
 * JSON, then the shape every frame has, and only then the schema of the
 * particular type — with the unknown-type exit taken *before* schema
 * validation, because a frame this server does not know cannot have a schema to
 * fail.
 *
 * Never throws. A decoder that threw would put the handler's error path in
 * charge of deciding what a bad frame means, which is this function's job.
 *
 * @param raw - The text or bytes of one WebSocket message.
 * @returns Accepted, ignored, or rejected with the close reason.
 */
export function decodeFrame(raw: RawFrame): DecodedFrame {
  const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.byteLength;
  if (size > MAX_FRAME_BYTES) {
    return rejected(
      closing(
        CloseCode.FRAME_TOO_LARGE,
        ErrorCode.PAYLOAD_TOO_LARGE,
        `A frame may not exceed ${MAX_FRAME_BYTES} bytes.`,
        `frame of ${size} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`,
      ),
    );
  }

  let text: string;
  if (typeof raw === 'string') {
    text = raw;
  } else {
    try {
      // A binary frame is not automatically wrong — a client may send the same
      // JSON as bytes — but bytes that are not UTF-8 cannot be JSON.
      text = UTF8.decode(raw);
    } catch {
      return malformed('frame bytes are not valid UTF-8');
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return malformed('frame is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return malformed('frame is not a JSON object');
  }

  const type: unknown = (parsed as Record<string, unknown>)['type'];
  if (typeof type !== 'string') {
    return malformed('frame has no string type field');
  }

  if (!CLIENT_FRAME_TYPES.has(type)) {
    // The additive-only rule (Plan §12.4). A newer client sending a frame type
    // that did not exist when this server was built is not a broken client, and
    // disconnecting it would make every future protocol addition a coordinated
    // upgrade of every machine running a listener.
    return { kind: 'ignored', type };
  }

  const result = ClientFrameSchema.safeParse(parsed);
  if (!result.success) {
    return rejected(
      closing(
        CloseCode.FRAME_INVALID,
        ErrorCode.PROTOCOL_VIOLATION,
        `The ${type} frame is missing a required field or has one of the wrong type.`,
        `${type} frame failed validation: ${result.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
          .join('; ')}`,
      ),
    );
  }

  return { kind: 'frame', frame: result.data };
}

/**
 * Serialises a server frame.
 *
 * @param frame - The frame to send.
 * @returns Its JSON text.
 */
export function encodeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}

// ---------------------------------------------------------------------------
// Identity of a bound socket
// ---------------------------------------------------------------------------

/**
 * Who and what a bound socket serves.
 *
 * The pair `(agentId, projectId)` is the registry key of Plan §4.3, and is
 * given a name here so T-307 and T-308 index on the same tuple this module
 * hands them rather than rebuilding it from a session record.
 */
export interface SocketIdentity {
  /** The authenticated user the socket belongs to. */
  readonly userId: UserId;

  /** The session the `hello` bound the socket to. */
  readonly sessionId: SessionId;

  /** The agent that session runs as. */
  readonly agentId: AgentId;

  /** The project that session runs in. */
  readonly projectId: ProjectId;
}
