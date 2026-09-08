/**
 * The wire vocabulary from the client's side: the frames it sends, the frames
 * it accepts, and what a close code means for whether to try again.
 *
 * ## Why these shapes are declared here and not in `@agentchat/protocol`
 *
 * They should eventually live there, and `../transport.ts` says as much. They
 * do not yet: `packages/protocol` deliberately omits the WebSocket schemas until
 * the milestone that settles the message contract, and the `message` payload is
 * still being written by another task as this one is. Declaring the *envelope*
 * here — the four server frame types of Plan §4.2, and nothing about what a
 * message contains — is what lets this transport exist without inventing a
 * shared contract, which §9 of the subagent protocol forbids. When the protocol
 * package grows the frame schemas, this module collapses into a re-export and
 * nothing above it changes.
 *
 * The close codes are the server's, copied rather than imported: `packages/` is
 * MIT and `server/` is AGPL, and the dependency arrow may not point that way at
 * any price. They are the wire contract, and the table in
 * `server/src/websocket/frames.ts` is the source it was copied from.
 *
 * ## The additive-only rule, from this end
 *
 * A client is subject to the same rule as the server (Plan §12.4): a frame type
 * it does not recognise is ignored, not fatal, because a newer server must be
 * able to add one without every listener in the field having to be upgraded
 * first. {@link decodeServerFrame} answers `ignored` for an unknown `type`, and
 * unknown *fields* survive validation — the `message` payload in particular is
 * parsed leniently so that every field this build has never heard of still
 * reaches the consumer intact.
 *
 * ## What a close code means
 *
 * {@link closeDisposition} is the decision the whole reconnect loop turns on,
 * and it exists because "retry with backoff" is the wrong answer to a permanent
 * refusal. A listener whose session has been deleted will never bind again,
 * however patiently it waits; retrying forever would turn a clear failure into
 * a process that appears to be working and silently never delivers anything.
 *
 * @module
 */

import {
  ErrorCode,
  isErrorCode,
  MessageId,
  SessionId,
  type WireErrorCode,
} from '@agentchat/protocol';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Close codes
// ---------------------------------------------------------------------------

/**
 * The close codes this client interprets.
 *
 * The 44xx values are the server's, from its own `CloseCode` table; the 10xx
 * values are RFC 6455's and can also be produced by an intermediary or by the
 * local WebSocket implementation, which is why {@link WsCloseCode.ABNORMAL}
 * appears here even though no server ever sends it.
 */
export const WsCloseCode = Object.freeze({
  /** Orderly shutdown by either side. RFC 6455 §7.4.1. */
  NORMAL: 1000,

  /** The peer is going away — a server shutting down for an upgrade. */
  GOING_AWAY: 1001,

  /**
   * No close frame was received: the connection dropped, or the upgrade never
   * completed. Synthesised locally; never sent by anyone.
   */
  ABNORMAL: 1006,

  /** The server failed while handling a frame. */
  INTERNAL_ERROR: 1011,

  /** Not UTF-8, not JSON, or not an object with a string `type`. */
  FRAME_MALFORMED: 4400,

  /** The upgrade carried no usable access token. */
  UNAUTHENTICATED: 4401,

  /** `hello` named a session that is not the caller's, or is not active. */
  SESSION_INVALID: 4403,

  /** A known frame other than `hello` arrived first, or `hello` arrived twice. */
  FRAME_OUT_OF_ORDER: 4409,

  /** The frame exceeded the server's size limit. */
  FRAME_TOO_LARGE: 4413,

  /** A known frame type whose payload failed its schema. */
  FRAME_INVALID: 4422,
});

/**
 * What to do about a closed socket.
 *
 * - `retry` — transient. Back off and reconnect.
 * - `refresh` — the credential was refused. Renew the access token and retry
 *   once; a second refusal is a genuine logout.
 * - `fatal` — a permanent refusal. Stop, and tell the caller why.
 */
export type CloseDisposition = 'retry' | 'refresh' | 'fatal';

/**
 * Close codes that will refuse the next attempt for exactly the same reason.
 *
 * Four of them (`4400`, `4409`, `4413`, `4422`) mean this client sent
 * something the server would not accept, which is a bug in this code and will
 * be a bug again on the next connection. `4403` means the session is gone: only
 * registering a new one can fix it, and that is the caller's decision, not a
 * decision a retry loop is allowed to make on its own.
 */
const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set<number>([
  WsCloseCode.FRAME_MALFORMED,
  WsCloseCode.SESSION_INVALID,
  WsCloseCode.FRAME_OUT_OF_ORDER,
  WsCloseCode.FRAME_TOO_LARGE,
  WsCloseCode.FRAME_INVALID,
]);

/**
 * How a close code should be answered.
 *
 * An unrecognised code is treated as transient. That is a deliberate asymmetry:
 * a newer server may close with a code this build has never seen, and the two
 * ways of being wrong are not equally bad — retrying something permanent costs
 * one connection attempt every thirty seconds and stays visible in the caller's
 * status events, while giving up on something transient strands a listener that
 * would have recovered on its own.
 *
 * @param code - The WebSocket close code.
 * @returns Whether to retry, refresh first, or stop.
 */
export function closeDisposition(code: number): CloseDisposition {
  if (code === WsCloseCode.UNAUTHENTICATED) {
    return 'refresh';
  }
  return FATAL_CLOSE_CODES.has(code) ? 'fatal' : 'retry';
}

// ---------------------------------------------------------------------------
// Client → server frames (Plan §4.1)
// ---------------------------------------------------------------------------

/** Binds a socket to a registered session. Must be the first frame. */
export interface HelloFrame {
  readonly type: 'hello';
  readonly sessionId: SessionId;
  readonly client?: string;
}

/** Acknowledges one delivered message, so the server stops replaying it. */
export interface AckFrame {
  readonly type: 'ack';
  readonly messageId: MessageId;
}

/** Liveness from the client's side. Answered with `pong`. */
export interface PingFrame {
  readonly type: 'ping';
}

/** Every frame this client sends. */
export type ClientFrame = HelloFrame | AckFrame | PingFrame;

/**
 * Builds the `hello` frame.
 *
 * Sent on **every** connection, not only the first. That is not a formality:
 * the handshake is what makes the server replay everything still pending for
 * this agent (Plan §4.3), so re-sending `hello` is the entire mechanism by which
 * a listener that was offline catches up. See `./listener.ts`.
 *
 * @param sessionId - The session this socket binds to.
 * @param client - The `X-AgentChat-Client` identifier, omitted when the
 *   embedder is not the `agentchat` CLI.
 * @returns The frame to send.
 */
export function helloFrame(sessionId: SessionId, client?: string): HelloFrame {
  return client === undefined ? { type: 'hello', sessionId } : { type: 'hello', sessionId, client };
}

/**
 * Builds an `ack` frame.
 *
 * @param messageId - The message being acknowledged.
 * @returns The frame to send.
 */
export function ackFrame(messageId: MessageId): AckFrame {
  return { type: 'ack', messageId };
}

/** The `ping` frame, which carries nothing and is therefore a constant. */
export const PING_FRAME: PingFrame = Object.freeze({ type: 'ping' });

// ---------------------------------------------------------------------------
// Server → client frames (Plan §4.2)
// ---------------------------------------------------------------------------

/**
 * The handshake completed. Everything pending was replayed *before* this frame,
 * so `pending` is a count of what has already arrived, not a promise of what is
 * coming.
 */
export const ReadyFrameSchema = z.object({
  type: z.literal('ready'),
  sessionId: SessionId.schema,

  // Defaulted rather than required. It is a diagnostic count, and a listener
  // that refused to consider itself connected because a server had stopped
  // sending a number would be broken by a change the additive rule permits.
  pending: z.number().int().min(0).default(0),
});

/** A parsed `ready`. */
export type ReadyFrame = z.infer<typeof ReadyFrameSchema>;

/**
 * One delivered message.
 *
 * `message` is validated for exactly one field — `messageId` — and otherwise
 * passed through with every key it arrived with (`looseObject`, not `object`,
 * which would silently strip them). The rest of the payload is the message
 * contract of Plan §4.2, which belongs to the messages service and its own
 * task; this module needs the identifier because deduplication is keyed on it,
 * and needs nothing else. A schema invented here for `sender` or `content`
 * would be a contract the messaging task then had to live with.
 */
export const MessageFrameSchema = z.object({
  type: z.literal('message'),
  message: z.looseObject({ messageId: MessageId.schema }),
});

/** A parsed `message`. */
export type MessageFrame = z.infer<typeof MessageFrameSchema>;

/** The delivered payload: `messageId` typed, everything else as it arrived. */
export type DeliveredMessage = MessageFrame['message'];

/** The answer to a client `ping`. */
export const PongFrameSchema = z.object({ type: z.literal('pong') });

/** A parsed `pong`. */
export type PongFrame = z.infer<typeof PongFrameSchema>;

/**
 * Something went wrong. The server sends one immediately before closing, so a
 * client that never reads close codes still learns why.
 *
 * `code` is a plain string rather than the `ErrorCode` enum because a newer
 * server may use a code this build has never heard of, and refusing to parse
 * the frame would lose the message that explains the close. Narrow with
 * `isErrorCode` before branching on it.
 */
export const ErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

/** A parsed `error`. */
export type ErrorFrame = z.infer<typeof ErrorFrameSchema>;

/** Every frame this client understands. */
export type ServerFrame = ReadyFrame | MessageFrame | PongFrame | ErrorFrame;

/** The frame schemas, keyed by the `type` they match. */
const SERVER_FRAME_SCHEMAS = {
  ready: ReadyFrameSchema,
  message: MessageFrameSchema,
  pong: PongFrameSchema,
  error: ErrorFrameSchema,
} as const;

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** A frame this client knows and accepts. */
export interface AcceptedServerFrame {
  readonly kind: 'frame';
  readonly frame: ServerFrame;
}

/**
 * A frame whose `type` this build has never heard of.
 *
 * Not an error and not answered: the additive-only rule doing its job. The type
 * is carried so a caller can report it once, which is how an operator finds out
 * a newer server is talking to an older listener.
 */
export interface IgnoredServerFrame {
  readonly kind: 'ignored';
  readonly type: string;
}

/**
 * A frame this client cannot use: not an object, no `type`, or a known type
 * whose payload does not validate.
 *
 * Unlike the server, the client does not close the socket over one of these.
 * Dropping a frame it cannot read costs one message; tearing down a connection
 * that is otherwise delivering costs every message after it.
 */
export interface InvalidServerFrame {
  readonly kind: 'invalid';
  readonly detail: string;
}

/** What an arriving frame turned out to be. */
export type DecodedServerFrame = AcceptedServerFrame | IgnoredServerFrame | InvalidServerFrame;

/**
 * Classifies one already-parsed frame from the server.
 *
 * The unknown-type exit is taken *before* schema validation, because a frame
 * this build does not know cannot have a schema to fail.
 *
 * Never throws: a decoder that threw would put the caller's error path in charge
 * of deciding what a bad frame means, which is this function's job.
 *
 * @param value - The JSON value the transport read off the socket.
 * @returns Accepted, ignored, or invalid with a detail for the caller to
 *   report. The detail names shapes, never contents: a frame body may hold a
 *   message that is none of a log's business.
 */
export function decodeServerFrame(value: unknown): DecodedServerFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid', detail: 'frame is not a JSON object' };
  }

  const type: unknown = (value as Record<string, unknown>)['type'];
  if (typeof type !== 'string') {
    return { kind: 'invalid', detail: 'frame has no string type field' };
  }

  if (!Object.hasOwn(SERVER_FRAME_SCHEMAS, type)) {
    return { kind: 'ignored', type };
  }

  const schema = SERVER_FRAME_SCHEMAS[type as keyof typeof SERVER_FRAME_SCHEMAS];
  const result = schema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.code}`)
      .join('; ');
    return { kind: 'invalid', detail: `${type} frame failed validation: ${detail}` };
  }

  return { kind: 'frame', frame: result.data };
}

/**
 * The known error code an `error` frame carries, for callers that want to
 * branch rather than display.
 *
 * @param frame - The frame as it arrived.
 * @returns The code if this build knows it, otherwise {@link ErrorCode.INTERNAL}
 *   — an unrecognised failure is still a failure.
 */
export function errorFrameCode(frame: ErrorFrame): ErrorCode {
  const wire: WireErrorCode = frame.code;
  return isErrorCode(wire) ? wire : ErrorCode.INTERNAL;
}
