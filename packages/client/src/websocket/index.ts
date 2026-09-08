/**
 * The listening half of the client: a socket that survives.
 *
 * Four pieces, each of which answers one question a long-running listener has
 * to get right, and each of which is testable on its own:
 *
 * - `./frames.ts` — what may be sent, what may arrive, and what a close code
 *   means for whether to try again.
 * - `./socket.ts` — opening a WebSocket, with no WebSocket dependency and a
 *   seam where one can be substituted.
 * - `./backoff.ts` — when to try again, jittered so a fleet does not reconnect
 *   in lockstep.
 * - `./dedupe.ts` — which messages have already been delivered, in bounded
 *   memory.
 *
 * `./listener.ts` is the loop that uses all four, and the only one most callers
 * name.
 *
 * @module
 */

export type { BackoffOptions, BackoffPolicy } from './backoff.js';
export { backoffDelayMs, DEFAULT_BACKOFF_POLICY, resolveBackoffPolicy } from './backoff.js';
export { DEFAULT_SEEN_CAPACITY, SeenMessages } from './dedupe.js';
export type {
  AckFrame,
  ClientFrame,
  CloseDisposition,
  DecodedServerFrame,
  DeliveredMessage,
  ErrorFrame,
  HelloFrame,
  MessageFrame,
  PingFrame,
  PongFrame,
  ReadyFrame,
  ServerFrame,
} from './frames.js';
export {
  ackFrame,
  closeDisposition,
  decodeServerFrame,
  ErrorFrameSchema,
  errorFrameCode,
  helloFrame,
  MessageFrameSchema,
  PING_FRAME,
  PongFrameSchema,
  ReadyFrameSchema,
  WsCloseCode,
} from './frames.js';
export type {
  ClosedReason,
  DuplicateMessage,
  HeartbeatOptions,
  ListenerErrorPhase,
  ListenerEvent,
  ListenerEventMap,
  ListenerHandler,
  ListenerProblem,
  ListenerStatus,
  SessionListenerOptions,
  TokenSource,
} from './listener.js';
export {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT,
  SessionListener,
} from './listener.js';
export type {
  CredentialPlacement,
  FrameConnector,
  FrameSocket,
  FrameStream,
  OpenSocketOptions,
  SocketClosure,
  SocketData,
  SocketHandlers,
  WebSocketConnectorOptions,
  WebSocketFactory,
} from './socket.js';
export {
  ACCESS_TOKEN_QUERY_PARAMETER,
  closureOf,
  DEFAULT_WEBSOCKET_PATH,
  nativeWebSocketFactory,
  WebSocketConnector,
} from './socket.js';
