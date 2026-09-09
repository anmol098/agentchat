/**
 * A durable listening session: the reconnect loop, the handshake, and the
 * deduplication that together make at-least-once delivery usable.
 *
 * ```ts
 * const listener = new SessionListener({
 *   connector: new WebSocketConnector({ baseUrl }),
 *   tokens: new TokenManager(store, redeem),
 *   sessionId,
 * });
 *
 * listener.on('message', (message) => {
 *   render(message);
 *   listener.ack(message.messageId);
 * });
 * listener.on('status', (status) => report(status));
 * listener.start();
 * ```
 *
 * ## Every reconnect re-sends `hello`
 *
 * This is the mechanism the entire offline story rests on, and it is one line
 * of code, so it is worth stating plainly. The server replays every pending
 * message for an agent when a socket says `hello` (Plan §4.3). Nothing else
 * triggers a replay: not a query, not a cursor, not the passage of time. So a
 * listener that reconnected without re-sending `hello` would come back
 * connected and permanently empty, having silently dropped everything that
 * arrived while it was away — which is exactly the failure the inbox exists to
 * prevent.
 *
 * ## Why there is no cursor
 *
 * A resume token is the obvious alternative: remember the last message and ask
 * the server for everything after it. It would be wrong here, twice over.
 *
 * The server already knows what this listener is owed, and knows it better: the
 * inbox tracks *acknowledged*, not *delivered*, so a message the consumer saw
 * but never acknowledged is still owed, and a cursor would have skipped past it.
 * A cursor would also be a second, disagreeing source of truth for the same
 * fact, and the moment the two disagreed the client's version would win and a
 * message would be lost for good. The correct client-side state is not a
 * position; it is the acknowledgements it sends, and the duplicate suppression
 * in `./dedupe.ts` that makes an over-generous replay harmless.
 *
 * ## What a close code decides
 *
 * `closeDisposition` in `./frames.ts` sorts a closed socket into three
 * outcomes, and the loop below does one of three things:
 *
 * - **retry** — back off with jitter and reconnect. Server restarts, network
 *   drops, a `1011`.
 * - **refresh** — `4401`. Renew the access token and retry immediately, once.
 *   The user is not prompted; that is the whole point of a refresh token. A
 *   second `4401` in the same streak is a genuine logout and is fatal.
 * - **fatal** — `4403` and the frame-level refusals. Stop, and say why.
 *   Retrying forever against a deleted session would leave a process that looks
 *   like a working listener and delivers nothing, which is worse than an error.
 *
 * There is one wrinkle a real deployment forces. A server that refuses the
 * *upgrade* with HTTP 401 gives the client no status at all — the WebSocket API
 * reports an opaque `1006`, indistinguishable from a network failure. So a
 * failure that never reached an open socket also earns one refresh per streak,
 * before the ordinary backoff. It costs a single token rotation per outage,
 * which the rotation design already expects, and without it a listener whose
 * token expired against such a server would back off forever holding a
 * credential it could have replaced.
 *
 * ## Events, not output
 *
 * Nothing here prints. `agentchat listen` has to keep operational logs on
 * stderr and message payloads on stdout, `--json` has to emit a status line per
 * transition, and an embedder may want none of that; a package that wrote to a
 * stream would be deciding all three. Every transition is an event, and what a
 * user sees is the caller's decision.
 *
 * @module
 */

import {
  CLIENT_VERSION_HEADER,
  ErrorCode,
  type MessageId,
  ProtocolError,
  SessionId,
} from '@agentchat/protocol';

import type { Credentials } from '../credentials.js';
import { TransportError } from '../errors.js';
import {
  type BackoffOptions,
  type BackoffPolicy,
  backoffDelayMs,
  resolveBackoffPolicy,
} from './backoff.js';
import { SeenMessages } from './dedupe.js';
import {
  ackFrame,
  closeDisposition,
  type DeliveredMessage,
  decodeServerFrame,
  type ErrorFrame,
  errorFrameCode,
  helloFrame,
  PING_FRAME,
  WsCloseCode,
} from './frames.js';
import {
  closureOf,
  DEFAULT_WEBSOCKET_PATH,
  type FrameConnector,
  type FrameStream,
  type SocketClosure,
} from './socket.js';

// ---------------------------------------------------------------------------
// Collaborators
// ---------------------------------------------------------------------------

/**
 * Where access tokens come from, and how they are renewed.
 *
 * Exactly the surface of `TokenManager`, which satisfies it structurally and is
 * what a caller should pass. Renewal is *not* reimplemented here: the manager
 * serialises concurrent refreshes and compares the token that actually failed
 * before spending a refresh token, because the server rotates refresh tokens
 * and presenting a spent one revokes the whole chain. A second refresh path in
 * this module would be a second way to log the user out.
 */
export interface TokenSource {
  /**
   * The credentials to use for the next connection.
   *
   * @returns The stored pair.
   * @throws {ProtocolError} `AUTH_REQUIRED` if nobody has logged in.
   */
  require(): Promise<Credentials>;

  /**
   * Obtains credentials newer than the ones a connection just failed with.
   *
   * @param spentAccessToken - The access token the refused connection carried.
   * @returns Credentials that are not the ones that just failed.
   * @throws {ProtocolError} `AUTH_REQUIRED` if the refresh was rejected.
   */
  renew(spentAccessToken: string): Promise<Credentials>;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** Why a listener stopped for good. */
export type ClosedReason =
  /** {@link SessionListener.stop} was called. */
  | 'stopped'
  /** The server refused the connection in a way that retrying cannot fix. */
  | 'refused'
  /** The credentials are gone or were rejected; the user must sign in again. */
  | 'unauthenticated';

/**
 * A connection state change.
 *
 * `connecting` and `reconnecting` are distinct because they answer different
 * questions for a user: one says an attempt is being made, the other says how
 * long until the next one and how many have failed. Plan §6.3's `--json` status
 * line is a projection of this union, not the union itself — deciding which
 * states a person sees is the CLI's job.
 */
export type ListenerStatus =
  | {
      readonly state: 'connecting';
      /** How many attempts have already failed in this streak. Zero is the first. */
      readonly attempt: number;
    }
  | {
      readonly state: 'connected';
      /** The session the server bound this socket to. */
      readonly sessionId: SessionId;
      /** How many pending messages were replayed just before `ready`. */
      readonly pending: number;
    }
  | {
      readonly state: 'reconnecting';
      /** How many attempts have failed, including the one that just did. */
      readonly attempt: number;
      /** How long until the next attempt, jittered. */
      readonly delayMs: number;
      /** How the connection ended. */
      readonly closure: SocketClosure;
    }
  | {
      readonly state: 'closed';
      /** Why this is terminal. */
      readonly reason: ClosedReason;
      /** The failure to report, or `null` when the caller asked to stop. */
      readonly error: ProtocolError | null;
      /** The close that ended it, when there was one. */
      readonly closure: SocketClosure | null;
    };

/** Where a non-fatal failure came from. */
export type ListenerErrorPhase =
  /** Opening the socket failed. */
  | 'connect'
  /** A frame arrived that could not be read. */
  | 'frame'
  /** The server sent an `error` frame. */
  | 'server'
  /** An acknowledgement could not be sent. */
  | 'ack'
  /** A token refresh failed for a reason that is not a logout. */
  | 'refresh'
  /** One of the caller's own event handlers threw. */
  | 'handler';

/** A failure the listener survived, reported so it is not silent. */
export interface ListenerProblem {
  /** What was being attempted. */
  readonly phase: ListenerErrorPhase;

  /** What went wrong. */
  readonly error: Error;
}

/** A message that was suppressed because it had already been delivered. */
export interface DuplicateMessage {
  /** The identifier that had been seen before. */
  readonly messageId: MessageId;
}

/** The events a listener emits, and what each carries. */
export interface ListenerEventMap {
  /** A connection state change. */
  status: ListenerStatus;

  /** A message, exactly once per identifier. */
  message: DeliveredMessage;

  /** A replayed message that was suppressed. Reported for observability only. */
  duplicate: DuplicateMessage;

  /** A failure the listener survived. */
  error: ListenerProblem;
}

/** The name of one event. */
export type ListenerEvent = keyof ListenerEventMap;

/** A handler for one event. */
export type ListenerHandler<K extends ListenerEvent> = (payload: ListenerEventMap[K]) => void;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Client-side liveness checking. */
export interface HeartbeatOptions {
  /** How long the socket may be silent before a `ping` is sent. */
  readonly intervalMs: number;

  /** How long to wait for any frame after that `ping` before giving up on it. */
  readonly responseTimeoutMs: number;
}

/**
 * Mirrors the server's own heartbeat (Plan §4.3: ping every 20 s, close after
 * 60 s of silence) from this end.
 *
 * It exists because the failure it catches is invisible otherwise: a TCP
 * connection whose peer has vanished — a laptop that changed networks, a NAT
 * that dropped the mapping — is not closed and never will be. Without a
 * watchdog the reconnect loop below never runs, because nothing ever tells it
 * the connection is dead, and the listener sits there looking healthy and
 * receiving nothing.
 */
export const DEFAULT_HEARTBEAT: HeartbeatOptions = Object.freeze({
  intervalMs: 20_000,
  responseTimeoutMs: 20_000,
});

/**
 * How long a connection may take to produce `ready`, in milliseconds.
 *
 * Covers the upgrade, the `hello`, and the replay that precedes `ready`. A
 * socket that opens and then says nothing is the one failure a close code
 * cannot report, so it is bounded by a timer and treated as a transient
 * failure.
 */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

/** Construction options for {@link SessionListener}. */
export interface SessionListenerOptions {
  /** How to open sockets. {@link WebSocketConnector}, or a daemon's equivalent. */
  readonly connector: FrameConnector;

  /** Where access tokens come from. Pass the client's `TokenManager`. */
  readonly tokens: TokenSource;

  /** The registered session this listener binds to on every connection. */
  readonly sessionId: SessionId | string;

  /** The endpoint. Defaults to {@link DEFAULT_WEBSOCKET_PATH}. */
  readonly path?: string;

  /**
   * The `X-AgentChat-Client` identifier, if any.
   *
   * Sent twice, on purpose: as the header on the upgrade request, and as
   * `client` in `hello`. The header is the one the server can act on — an
   * upgrade is an HTTP request and protocol §2.2 says the CLI sends the header
   * on every one, so a client below `minClientVersion` is refused with a `426`
   * while HTTP is still available to carry the instruction. The `hello` field
   * is what the server logs against the session.
   */
  readonly client?: string;

  /** Reconnect schedule. Defaults to 1 s doubling to 30 s with equal jitter. */
  readonly backoff?: BackoffOptions;

  /** How many message identifiers to remember. See `./dedupe.ts`. */
  readonly dedupeCapacity?: number;

  /** How long to wait for `ready`. Defaults to {@link DEFAULT_HANDSHAKE_TIMEOUT_MS}. */
  readonly handshakeTimeoutMs?: number;

  /** Liveness checking, or `null` to rely entirely on the server's. */
  readonly heartbeat?: HeartbeatOptions | null;
}

/** What one connection attempt turned into. */
interface AttemptOutcome {
  /** How it ended. */
  readonly closure: SocketClosure;

  /** Whether the upgrade completed at all. */
  readonly opened: boolean;

  /** Whether the server answered `ready`. */
  readonly ready: boolean;
}

// ---------------------------------------------------------------------------
// The listener
// ---------------------------------------------------------------------------

/**
 * One session's connection to the server, kept alive across failures.
 *
 * Start it once; it reconnects on its own until it is stopped or permanently
 * refused. Every message it emits has been seen for the first time, and every
 * transition it makes is an event.
 */
export class SessionListener {
  readonly #connector: FrameConnector;
  readonly #tokens: TokenSource;
  readonly #sessionId: SessionId;
  readonly #path: string;
  readonly #client: string | undefined;
  readonly #backoff: BackoffPolicy;
  readonly #seen: SeenMessages;
  readonly #handshakeTimeoutMs: number;
  readonly #heartbeat: HeartbeatOptions | null;

  readonly #handlers: { [K in ListenerEvent]: Set<ListenerHandler<K>> } = {
    status: new Set(),
    message: new Set(),
    duplicate: new Set(),
    error: new Set(),
  };

  #state: ListenerStatus['state'] | 'idle' = 'idle';
  #loop: Promise<void> | null = null;
  #stopping = false;
  #stream: FrameStream | null = null;
  #bound = false;
  #lastServerError: ErrorFrame | null = null;
  #refreshedThisStreak = false;
  #wake: (() => void) | null = null;
  #abort: AbortController | null = null;
  #lastAccessToken: string | null = null;
  #silenceTimer: ReturnType<typeof setTimeout> | null = null;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param options - Connector, tokens, session, and the policies above.
   * @throws {ProtocolError} `BAD_REQUEST` if the session id is not one, or if a
   *   backoff or deduplication option is out of range. Configuration is checked
   *   here rather than at the first disconnection, which would be the worst
   *   possible moment to find out.
   */
  public constructor(options: SessionListenerOptions) {
    this.#connector = options.connector;
    this.#tokens = options.tokens;
    this.#sessionId = SessionId.parse(options.sessionId);
    this.#path = options.path ?? DEFAULT_WEBSOCKET_PATH;
    this.#client = options.client;
    this.#backoff = resolveBackoffPolicy(options.backoff);
    this.#seen = new SeenMessages(options.dedupeCapacity);
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.#heartbeat = options.heartbeat === undefined ? DEFAULT_HEARTBEAT : options.heartbeat;
  }

  /** The session this listener binds to. */
  public get sessionId(): SessionId {
    return this.#sessionId;
  }

  /** Where the connection currently is. `idle` until {@link start}. */
  public get state(): ListenerStatus['state'] | 'idle' {
    return this.#state;
  }

  /** How many distinct message identifiers are currently remembered. */
  public get seenCount(): number {
    return this.#seen.size;
  }

  /**
   * Subscribes to an event.
   *
   * @param event - Which event.
   * @param handler - What to call. A handler that throws is reported as an
   *   `error` event and does not disturb the connection.
   * @returns A function that unsubscribes.
   */
  public on<K extends ListenerEvent>(event: K, handler: ListenerHandler<K>): () => void {
    this.#handlers[event].add(handler);
    return () => {
      this.#handlers[event].delete(handler);
    };
  }

  /**
   * Unsubscribes a handler.
   *
   * @param event - Which event.
   * @param handler - The handler passed to {@link on}.
   */
  public off<K extends ListenerEvent>(event: K, handler: ListenerHandler<K>): void {
    this.#handlers[event].delete(handler);
  }

  /**
   * Connects, and keeps connecting until stopped or permanently refused.
   *
   * Returns immediately; progress arrives as `status` events. Calling it again
   * while it is running does nothing, so a caller does not have to track
   * whether it has started.
   */
  public start(): void {
    if (this.#loop !== null) {
      return;
    }
    this.#stopping = false;
    this.#abort = new AbortController();
    this.#loop = this.#run().catch((error: unknown) => {
      // The loop is written not to throw. If it ever does, the listener still
      // has to end in a state the caller can see rather than a silent stop.
      this.#finish('refused', asProtocolError(error), null);
    });
  }

  /**
   * Closes the connection and stops reconnecting. Idempotent.
   *
   * @returns When the loop has finished and the socket is closed.
   */
  public async stop(): Promise<void> {
    this.#stopping = true;
    this.#wake?.();
    // Aborts an upgrade that is still in flight. Without it a `stop` racing a
    // slow handshake would return while the socket it thought it had closed
    // was still being opened.
    this.#abort?.abort();
    this.#stream?.close(WsCloseCode.NORMAL, 'listener stopped');
    const loop = this.#loop;
    if (loop !== null) {
      await loop;
    }
  }

  /**
   * Acknowledges a message, so the server stops replaying it.
   *
   * Deliberately not automatic. Plan §6.3 acknowledges only after the payload
   * has actually been written to stdout, because an ack sent earlier would
   * throw the message away on behalf of a consumer that never saw it — and only
   * the consumer knows when that is.
   *
   * An acknowledgement for a connection that has since dropped is not an error
   * and is not queued: the message is still pending server-side, so the next
   * `hello` replays it and the deduplication keeps that invisible. Retrying it
   * later against a different socket would acknowledge on a session that never
   * received it.
   *
   * @param messageId - The message to acknowledge.
   * @returns Whether the frame was actually sent.
   */
  public ack(messageId: MessageId): boolean {
    const stream = this.#stream;
    if (stream === null || !this.#bound) {
      return false;
    }
    try {
      stream.send(ackFrame(messageId));
      return true;
    } catch (error) {
      this.#report('ack', error);
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  /**
   * Connects, handles the connection, and decides what to do when it ends,
   * until something says to stop.
   *
   * @returns When the listener is finished for good.
   */
  async #run(): Promise<void> {
    let attempt = 0;
    this.#refreshedThisStreak = false;

    while (!this.#stopping) {
      this.#publish({ state: 'connecting', attempt });

      const outcome = await this.#attempt();
      if (this.#stopping) {
        break;
      }

      if (outcome.ready) {
        // A connection that reached `ready` is proof the server, the network
        // and the credential are all working, so the next failure starts its
        // own streak rather than inheriting the delay of an old one.
        attempt = 0;
        this.#refreshedThisStreak = false;
      }

      const disposition = outcome.closure.local ? 'retry' : closeDisposition(outcome.closure.code);

      if (disposition === 'fatal') {
        this.#finish('refused', this.#refusalError(outcome.closure), outcome.closure);
        return;
      }

      if (disposition === 'refresh') {
        if (this.#refreshedThisStreak) {
          // One refresh and one retry, exactly as the HTTP pipeline does it. A
          // second refusal with a token minted seconds ago is not an expiry.
          this.#finish('unauthenticated', sessionExpired(), outcome.closure);
          return;
        }
        if (await this.#refresh(outcome.closure)) {
          continue;
        }
        this.#finish('unauthenticated', sessionExpired(), outcome.closure);
        return;
      }

      // An upgrade refused with HTTP 401 is reported as an opaque close, so a
      // failure that never opened a socket is also worth one refresh. See the
      // module note.
      if (!outcome.opened && !this.#refreshedThisStreak) {
        // Best effort: a definitive rejection here clears the store, and the
        // next attempt's `require` is what turns that into a clean stop.
        await this.#refresh(outcome.closure);
      }

      const delayMs = backoffDelayMs(attempt, this.#backoff);
      attempt += 1;
      this.#publish({ state: 'reconnecting', attempt, delayMs, closure: outcome.closure });
      await this.#pause(delayMs);
    }

    this.#finish('stopped', null, null);
  }

  /**
   * One connection, from upgrade to close.
   *
   * @returns How it ended, and how far it got.
   */
  async #attempt(): Promise<AttemptOutcome> {
    this.#bound = false;
    this.#lastServerError = null;

    let credentials: Credentials;
    try {
      credentials = await this.#tokens.require();
    } catch (error) {
      // Nobody is logged in. No amount of reconnecting fixes that, and
      // prompting is not this package's decision.
      this.#finish('unauthenticated', asProtocolError(error), null);
      this.#stopping = true;
      return { closure: localClosure('not signed in'), opened: false, ready: false };
    }

    // Remembered because a refusal is answered by renewing *this* token: the
    // manager compares it against the store to tell a genuine expiry from a
    // refusal that raced a refresh another connection already made.
    this.#lastAccessToken = credentials.accessToken;

    const signal = this.#abort?.signal;
    let stream: FrameStream;
    try {
      stream = await this.#connector.connect({
        path: this.#path,
        headers: {
          authorization: `Bearer ${credentials.accessToken}`,
          // An upgrade is an HTTP request, so it carries the same version
          // header as every other one (protocol §2.2). Announcing it only in
          // `hello` would be too late to be enforced: the frame arrives after
          // the handshake, where a refusal can only be a close code, and this
          // way the socket path answers a client below the floor with the same
          // `426` and the same sentence the HTTP path does.
          ...(this.#client === undefined ? {} : { [CLIENT_VERSION_HEADER]: this.#client }),
        },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      const refused = closureOf(error);
      if (refused === null) {
        this.#report('connect', error);
      }
      return {
        closure: refused ?? failedClosure(error),
        opened: false,
        ready: false,
      };
    }

    this.#stream = stream;
    let ready = false;

    try {
      // The frame that makes the server replay everything pending. Sent on
      // every connection, which is the whole of the catch-up mechanism.
      stream.send(helloFrame(this.#sessionId, this.#client));
      this.#bound = true;
      this.#armHandshakeTimer(stream);

      for await (const raw of stream) {
        this.#armSilenceTimer(stream);
        if (this.#consume(raw)) {
          ready = true;
          this.#clearTimer('handshake');
        }
      }
    } catch (error) {
      // `send` on a socket the peer closed between the upgrade and the first
      // frame. Closing here is what guarantees the closure below resolves.
      this.#report('frame', error);
      stream.close(WsCloseCode.NORMAL, 'frame handling failed');
    } finally {
      this.#clearTimer('handshake');
      this.#clearTimer('silence');
      this.#bound = false;
      this.#stream = null;
    }

    return { closure: await stream.closure, opened: true, ready };
  }

  /**
   * Handles one arriving frame.
   *
   * @param raw - The value read off the socket.
   * @returns Whether this frame was `ready`.
   */
  #consume(raw: unknown): boolean {
    const decoded = decodeServerFrame(raw);

    if (decoded.kind === 'invalid') {
      this.#report(
        'frame',
        new TransportError(`Unusable frame from the server: ${decoded.detail}`),
      );
      return false;
    }
    if (decoded.kind === 'ignored') {
      // A frame type this build has never heard of: a newer server, doing
      // something additive. Not an error and not reported as one.
      return false;
    }

    const frame = decoded.frame;
    switch (frame.type) {
      case 'ready': {
        this.#publish({ state: 'connected', sessionId: frame.sessionId, pending: frame.pending });
        return true;
      }
      case 'message': {
        const { messageId } = frame.message;
        if (this.#seen.admit(messageId)) {
          this.#emit('message', frame.message);
        } else {
          // A replay after an acknowledgement that never landed. Exactly what
          // the memory in ./dedupe.ts is for; the consumer never learns of it
          // except through this event.
          this.#emit('duplicate', { messageId });
        }
        return false;
      }
      case 'error': {
        // Kept so that the close about to follow can be reported with the
        // server's own words rather than a bare number.
        this.#lastServerError = frame;
        this.#report('server', new ProtocolError(errorFrameCode(frame), frame.message));
        return false;
      }
      default:
        // `pong`. The frame having arrived at all is the liveness signal; the
        // timer was reset before this was decoded.
        return false;
    }
  }

  /**
   * Renews the access token after a refused connection.
   *
   * @param closure - The close that prompted it, for the error's context.
   * @returns `true` if there is a newer credential to retry with, `false` if
   *   the refresh was definitively rejected.
   */
  async #refresh(closure: SocketClosure): Promise<boolean> {
    this.#refreshedThisStreak = true;
    const spent = this.#lastAccessToken;
    if (spent === null) {
      return false;
    }

    try {
      await this.#tokens.renew(spent);
      return true;
    } catch (error) {
      if (error instanceof ProtocolError && error.code === ErrorCode.AUTH_REQUIRED) {
        return false;
      }
      // The refresh itself could not be performed — the server is unreachable,
      // which is very likely why the socket failed too. Not a logout: back off
      // and try the whole thing again.
      this.#report('refresh', error);
      return closure.code !== WsCloseCode.UNAUTHENTICATED;
    }
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /**
   * Waits out a backoff delay, or returns early if the listener is stopped.
   *
   * @param delayMs - How long to wait.
   * @returns When the wait is over.
   */
  #pause(delayMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = null;
        resolve();
      }, delayMs);
      this.#wake = (): void => {
        clearTimeout(timer);
        this.#wake = null;
        resolve();
      };
    });
  }

  /**
   * Bounds how long a connection may take to say `ready`.
   *
   * @param stream - The connection to close if it does not.
   */
  #armHandshakeTimer(stream: FrameStream): void {
    this.#clearTimer('handshake');
    this.#handshakeTimer = setTimeout(() => {
      stream.close(WsCloseCode.NORMAL, 'no ready frame');
    }, this.#handshakeTimeoutMs);
  }

  /**
   * Restarts the liveness watchdog after any sign of life.
   *
   * @param stream - The connection being watched.
   */
  #armSilenceTimer(stream: FrameStream): void {
    const heartbeat = this.#heartbeat;
    if (heartbeat === null) {
      return;
    }
    this.#clearTimer('silence');
    this.#silenceTimer = setTimeout(() => {
      try {
        stream.send(PING_FRAME);
      } catch {
        // Already closed; the loop is about to notice.
        return;
      }
      this.#silenceTimer = setTimeout(() => {
        stream.close(WsCloseCode.NORMAL, 'server stopped responding');
      }, heartbeat.responseTimeoutMs);
    }, heartbeat.intervalMs);
  }

  /**
   * Cancels one timer.
   *
   * @param which - Which of the two.
   */
  #clearTimer(which: 'handshake' | 'silence'): void {
    const timer = which === 'handshake' ? this.#handshakeTimer : this.#silenceTimer;
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (which === 'handshake') {
      this.#handshakeTimer = null;
    } else {
      this.#silenceTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  /**
   * Records a state change and tells the caller about it.
   *
   * @param status - The new state.
   */
  #publish(status: ListenerStatus): void {
    this.#state = status.state;
    this.#emit('status', status);
  }

  /**
   * Ends the listener for good.
   *
   * @param reason - Why.
   * @param error - The failure to report, or `null` for a requested stop.
   * @param closure - The close that ended it, when there was one.
   */
  #finish(reason: ClosedReason, error: ProtocolError | null, closure: SocketClosure | null): void {
    if (this.#state === 'closed') {
      return;
    }
    this.#stopping = true;
    this.#stream?.close(WsCloseCode.NORMAL, 'listener stopped');
    this.#publish({ state: 'closed', reason, error, closure });
  }

  /**
   * Turns a permanent close into the error the caller is told about.
   *
   * Prefers the server's own `error` frame, which carries a remedy written for
   * a person — "Start a new listener with: agentchat listen --runtime <name>" —
   * over anything this module could reconstruct from a number.
   *
   * @param closure - The close.
   * @returns The error to report.
   */
  #refusalError(closure: SocketClosure): ProtocolError {
    const sent = this.#lastServerError;
    if (sent !== null) {
      return new ProtocolError(errorFrameCode(sent), sent.message);
    }
    return new ProtocolError(
      contractCodeForClose(closure.code),
      `The server closed the connection with code ${closure.code}${
        closure.reason === '' ? '' : `: ${closure.reason}`
      }.`,
    );
  }

  /**
   * Reports a failure the listener survived.
   *
   * @param phase - What was being attempted.
   * @param error - What went wrong.
   */
  #report(phase: ListenerErrorPhase, error: unknown): void {
    this.#emit('error', { phase, error: asError(error) });
  }

  /**
   * Calls every handler for an event.
   *
   * A handler that throws must not be able to stop a delivery loop or kill the
   * connection, so its failure becomes an `error` event instead. A failing
   * `error` handler is swallowed, because the alternative is a loop.
   *
   * @param event - Which event.
   * @param payload - What to pass.
   */
  #emit<K extends ListenerEvent>(event: K, payload: ListenerEventMap[K]): void {
    for (const handler of this.#handlers[event]) {
      try {
        handler(payload);
      } catch (error) {
        if (event === 'error') {
          continue;
        }
        this.#report('handler', error);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The contract code that best describes a permanent close. */
const CONTRACT_CODE_BY_CLOSE: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [WsCloseCode.FRAME_MALFORMED, ErrorCode.PROTOCOL_VIOLATION],
  [WsCloseCode.SESSION_INVALID, ErrorCode.SESSION_INVALID],
  [WsCloseCode.FRAME_OUT_OF_ORDER, ErrorCode.PROTOCOL_VIOLATION],
  [WsCloseCode.FRAME_TOO_LARGE, ErrorCode.PAYLOAD_TOO_LARGE],
  [WsCloseCode.FRAME_INVALID, ErrorCode.PROTOCOL_VIOLATION],
  [WsCloseCode.UNAUTHENTICATED, ErrorCode.AUTH_REQUIRED],
]);

/**
 * The contract code for a close code, for callers that branch on codes.
 *
 * @param code - The WebSocket close code.
 * @returns The matching contract code, or `INTERNAL` for a code with no
 *   documented meaning.
 */
function contractCodeForClose(code: number): ErrorCode {
  return CONTRACT_CODE_BY_CLOSE.get(code) ?? ErrorCode.INTERNAL;
}

/** The error a listener ends with when its credentials are finished. */
function sessionExpired(): ProtocolError {
  return new ProtocolError(
    ErrorCode.AUTH_REQUIRED,
    'Your session has expired. Run: agentchat login',
  );
}

/**
 * A close this side manufactured because there was never a socket to close.
 *
 * @param reason - What happened.
 * @returns The closure.
 */
function localClosure(reason: string): SocketClosure {
  return { code: WsCloseCode.NORMAL, reason, local: true, error: null };
}

/**
 * A close standing in for a connection attempt that failed without one.
 *
 * @param error - Why it failed.
 * @returns The closure, carrying the error.
 */
function failedClosure(error: unknown): SocketClosure {
  return {
    code: WsCloseCode.ABNORMAL,
    reason: 'the connection could not be opened',
    local: false,
    error: asError(error),
  };
}

/**
 * Narrows anything thrown to an `Error`.
 *
 * @param value - Whatever was caught.
 * @returns An error, wrapping the value if it was not one.
 */
function asError(value: unknown): Error {
  return value instanceof Error ? value : new TransportError(String(value));
}

/**
 * Narrows anything thrown to a `ProtocolError`, so a caller always has a code.
 *
 * @param value - Whatever was caught.
 * @returns A protocol error, wrapping the value if it was not one.
 */
function asProtocolError(value: unknown): ProtocolError {
  if (value instanceof ProtocolError) {
    return value;
  }
  const error = asError(value);
  return new ProtocolError(ErrorCode.INTERNAL, error.message, { cause: error });
}
