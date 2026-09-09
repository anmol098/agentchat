/**
 * `@agentchat/client` — the typed AgentChat client.
 *
 * Everything the CLI and any third-party integration needs to talk to an
 * AgentChat server: a transport seam, credential handling, token refresh that
 * survives concurrency, error translation onto the protocol's stable codes, and
 * a typed method per endpoint whose schema exists.
 *
 * ```ts
 * import { AgentChatClient, InMemoryCredentialStore } from '@agentchat/client';
 *
 * const client = new AgentChatClient({
 *   baseUrl: 'https://chat.example.com',
 *   credentials: new InMemoryCredentialStore(),
 *   clientVersion: '0.1.0',
 * });
 * ```
 *
 * ## Three rules this package keeps
 *
 * **No filesystem.** Credentials are an interface (`CredentialStore`), never a
 * path. The CLI implements it; a browser or a server embedder implements it
 * differently.
 *
 * **No invented shapes.** Every request body is validated and every response is
 * parsed with a schema from `@agentchat/protocol`. Nothing here casts a response
 * and nothing here declares a wire shape of its own.
 *
 * **No dependency on `server/`.** This package is MIT and the server is AGPL;
 * MIT may be absorbed into AGPL and never the reverse, so the arrow points one
 * way only. Its sole runtime dependencies are `@agentchat/protocol` and `zod`.
 *
 * @packageDocumentation
 */

export type { ApiClientOptions, AuthRequirement, Call, Received, RequestOptions } from './api.js';
export { ApiClient, signalOf } from './api.js';
export type { AgentChatClientOptions } from './client.js';
export { AgentChatClient } from './client.js';
export type { CredentialStore, Credentials } from './credentials.js';
export { InMemoryCredentialStore } from './credentials.js';
export {
  ApiError,
  apiErrorFromResponse,
  codeForStatus,
  ResponseFormatError,
  TransportError,
} from './errors.js';
export type { FetchLike, HttpTransportOptions } from './http-transport.js';
export { HttpTransport, normaliseBaseUrl } from './http-transport.js';
export { AgentsApi } from './resources/agents.js';
export { AuthApi } from './resources/auth.js';
export { ConversationsApi } from './resources/conversations.js';
export { InvitesApi } from './resources/invites.js';
export type { SendMessageOutcome } from './resources/messages.js';
export { MessagesApi } from './resources/messages.js';
export { ProjectsApi } from './resources/projects.js';
export { SessionsApi } from './resources/sessions.js';
export { VersionApi } from './resources/version.js';
export type { RefreshCall } from './tokens.js';
export { TokenManager } from './tokens.js';
export type {
  Connection,
  ConnectOptions,
  HttpMethod,
  QueryValue,
  Transport,
  TransportRequest,
  TransportResponse,
} from './transport.js';
export type {
  ClientTooOld,
  Compatibility,
  CompatibilityInputs,
  Compatible,
  ServerOlder,
  WarningSink,
} from './version.js';
export { checkCompatibility, createServerOlderWarner, serverOlderWarning } from './version.js';
export type {
  AckFrame,
  BackoffOptions,
  BackoffPolicy,
  ClientFrame,
  CloseDisposition,
  ClosedReason,
  CredentialPlacement,
  DecodedServerFrame,
  DeliveredMessage,
  DuplicateMessage,
  ErrorFrame,
  FrameConnector,
  FrameSocket,
  FrameStream,
  HeartbeatOptions,
  HelloFrame,
  ListenerErrorPhase,
  ListenerEvent,
  ListenerEventMap,
  ListenerHandler,
  ListenerProblem,
  ListenerStatus,
  MessageFrame,
  OpenSocketOptions,
  PingFrame,
  PongFrame,
  ReadyFrame,
  ServerFrame,
  SessionListenerOptions,
  SocketClosure,
  SocketData,
  SocketHandlers,
  TokenSource,
  WebSocketConnectorOptions,
  WebSocketFactory,
} from './websocket/index.js';
export {
  ACCESS_TOKEN_QUERY_PARAMETER,
  ackFrame,
  backoffDelayMs,
  closeDisposition,
  closureOf,
  DEFAULT_BACKOFF_POLICY,
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_HEARTBEAT,
  DEFAULT_SEEN_CAPACITY,
  DEFAULT_WEBSOCKET_PATH,
  decodeServerFrame,
  ErrorFrameSchema,
  errorFrameCode,
  helloFrame,
  MessageFrameSchema,
  nativeWebSocketFactory,
  PING_FRAME,
  PongFrameSchema,
  ReadyFrameSchema,
  resolveBackoffPolicy,
  SeenMessages,
  SessionListener,
  WebSocketConnector,
  WsCloseCode,
} from './websocket/index.js';
