/**
 * Liveness: proving a socket is still there, and telling the truth about its
 * session when it is not.
 *
 * Plan §4.3 is one line — "server pings every 20 s; no pong in 60 s → close
 * socket, mark session stale" — and it names two different failures that happen
 * to share a remedy.
 *
 * A TCP connection whose peer has vanished does not report anything. The
 * laptop closed, the network dropped, the process was killed with `SIGKILL`
 * before it could send a close frame: in every one of those the socket stays
 * open on this side, sometimes for hours, because nothing on the wire says
 * otherwise. Two things go wrong while it does.
 *
 * - **Sockets accumulate.** Each dead one holds a file descriptor, a registry
 *   entry, and whatever the delivery path writes into it.
 * - **Presence lies.** This is the worse half. Presence is derived from session
 *   status — `activeSessionPredicate()` in `../services/sessions.ts` — and
 *   discovery reads it to tell a human which agents are reachable. A session
 *   left `active` because nothing noticed its listener died makes `agentchat
 *   agents` report an agent that will never answer, at exactly the moment
 *   somebody is consulting it to decide who to message.
 *
 * ## Why the ping is a protocol control frame and not a `ping` frame
 *
 * `ServerFrame` in `./frames.ts` is `ready | message | pong | error`. There is
 * no server-to-client `ping`, and the wire protocol is snapshotted by
 * `pnpm protocol:check` and settled in the plan before it is implemented, so
 * adding one here would be exactly the unilateral change to a shared contract
 * that CLAUDE.md forbids.
 *
 * It would also be redundant. RFC 6455 §5.5.2 requires an endpoint to answer a
 * Ping control frame with a Pong "as soon as is practical", and that happens
 * inside the WebSocket implementation, below any application code. So the
 * control frame costs no client work at all, whereas an application-level
 * `ping` frame would need every client — including ones nobody here writes — to
 * grow a handler before liveness worked. Liveness that depends on the peer
 * having implemented something is not liveness.
 *
 * The direction the protocol *does* define, client `ping` → server `pong`, is
 * already answered in `./handler.ts` before any hook runs, deliberately, so
 * that it does not depend on this module being installed. Nothing here
 * reimplements it. See {@link createHeartbeat} for why `pinged` is not
 * implemented either.
 *
 * ## One sweep, not a timer per socket
 *
 * Every watched socket is pinged and judged by a single interval walking a set,
 * rather than each socket carrying its own interval and its own deadline timer.
 *
 * The obvious objection is T-031, which this project filed against a store that
 * "walks its whole map on every request". That finding is about the *request
 * path*: the sweep there ran from `start` and `poll`, both unauthenticated, so
 * an unauthenticated caller set how often an O(n) scan happened and the cost was
 * quadratic in the store's own size. A sweep on a timer has none of that shape —
 * its frequency is set by the clock, not by a caller — and T-031's own
 * acceptance criteria named "a periodic sweep on a timer rather than on the
 * request path" as an acceptable remedy. It chose the ordered structure instead
 * for a reason stated in its log: "a timer needs an owner and the file that
 * would stop it belongs to another task."
 *
 * This module is that owner. A file whose entire job is a timer can hold one.
 *
 * What decides it is shutdown. Per socket, N connections mean 2N live timers,
 * and the process can only exit if every one of those cleanups ran; a single
 * missed one is a suite that hangs and a deploy that stalls, and the bug is
 * invisible until the connection count is high enough to make it likely. One
 * sweep has exactly one thing to stop, so "did every timer get cleared" stops
 * being a question anybody can get wrong. It is belt-and-braced anyway: the
 * interval is `unref`'d, so even a caller that never calls {@link
 * HeartbeatService.stop} cannot hold the event loop open.
 *
 * The scaling argument points the same way, but it is the smaller one. O(n)
 * work every twenty seconds against a set of sockets this process is already
 * holding open is not a cost worth two timers per connection.
 *
 * ## The deadline errs late, never early
 *
 * A sweep granularity of twenty seconds cannot detect a sixty-second silence at
 * the sixtieth second unless the tick lands there. A socket is reaped on the
 * first tick at which it has been silent for at least {@link PONG_TIMEOUT_MS},
 * so the real deadline is sixty seconds plus up to one interval.
 *
 * That asymmetry is deliberate and is the right way round. Closing early kills
 * a listener that is alive and would have answered — a user-visible fault this
 * module invented. Closing late leaves presence stale for at most twenty extra
 * seconds, and the session sweeper in `../services/sessions.ts` is already
 * running on the same order of magnitude and would catch it regardless. When
 * the two error directions are "break a working thing" and "be slightly slow at
 * something with a backstop", there is no trade to weigh.
 *
 * ## Two halves that do not need each other
 *
 * The socket half ({@link HeartbeatService.watch}) works in raw sockets and
 * knows nothing about sessions. The session half
 * ({@link HeartbeatService.closed}) is a {@link ConnectionObserver} and works in
 * bindings, knowing nothing about timers.
 *
 * They are split because they cover different populations. A socket that
 * authenticates and never sends `hello` never produces a binding, so the
 * observer never hears about it — but it is still a socket this process is
 * holding, and the watch set reaps it like any other. Conversely a bound
 * session must be marked stale whether it timed out here or the client closed
 * the tab. Deriving either half from the other would leave one of those cases
 * uncovered.
 *
 * @module
 */

import type { SessionId, UserId } from '@stackgrid/protocol';
import { HEARTBEAT_TIMEOUT_SECONDS } from '../services/sessions.js';
import { CloseCode } from './frames.js';
import type { ConnectionObserver, SocketBinding, SocketLogger } from './handler.js';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** Milliseconds in a second, so the conversion below is not a bare `1000`. */
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * How often the sweep runs, and therefore how often a live socket is pinged.
 *
 * Plan §4.3's twenty seconds. A third of {@link PONG_TIMEOUT_MS}, so a peer has
 * to miss three consecutive pings before it is judged gone — one lost ping, or
 * one garbage-collection pause on a busy listener, is not a disconnection.
 *
 * Deliberately *not* `SESSION_SWEEP_INTERVAL_MS` from `../services/sessions.ts`,
 * despite both being twenty seconds today. That one is how often a database
 * statement ages rows; this one is how often bytes go on a wire. They agree by
 * coincidence of the same plan paragraph, not because either derives from the
 * other, and importing it would make a future change to one silently retune the
 * other.
 */
export const PING_INTERVAL_MS = 20_000;

/**
 * Silence after which a socket is considered dead.
 *
 * Derived from `HEARTBEAT_TIMEOUT_SECONDS` rather than restated as `60_000`,
 * because it is the *same fact* as the session service's staleness threshold:
 * sixty seconds without evidence of life is what "stale" means in this system,
 * and a socket reaped on one clock while its session ages on a different one
 * would be two definitions of the same word waiting to drift apart.
 */
export const PONG_TIMEOUT_MS = HEARTBEAT_TIMEOUT_SECONDS * MILLISECONDS_PER_SECOND;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * The transport, reduced to what this module does with it.
 *
 * Wider than `FrameSocket` in `./handler.ts`, and necessarily so: that
 * interface is `send` and `close` because the handshake works in application
 * frames, while this module works one layer down in RFC 6455 control frames.
 *
 * `ws`'s `WebSocket` satisfies this structurally — its `ping()` takes optional
 * arguments and its `on` overloads cover both events — so the adapter passes
 * the socket through unchanged and no adapter object exists here to go stale.
 * `heartbeat.test.ts` asserts that structural fit at compile time, so a `ws`
 * upgrade that changed one of these signatures fails the build rather than
 * failing in production at the first disconnect.
 */
export interface HeartbeatSocket {
  /** Sends an RFC 6455 §5.5.2 Ping control frame. */
  ping(): void;

  /**
   * Destroys the connection without a closing handshake.
   *
   * `close()` would be wrong here. It sends a close frame and waits for the
   * peer to answer, and the peer under discussion has already demonstrated it
   * answers nothing — so the socket would sit for the implementation's full
   * close timeout before being destroyed anyway, and would report close code
   * 1000, which is the code for an *orderly* shutdown. Reporting a dead peer as
   * an orderly departure is exactly the distinction {@link
   * HeartbeatService.closed} exists to draw.
   *
   * Terminating yields 1006 instead, RFC 6455's "abnormal closure", which is
   * what happened.
   */
  terminate(): void;

  /** The peer answered a ping. */
  on(event: 'pong', listener: () => void): unknown;

  /** The socket is gone, for any reason. */
  on(event: 'close', listener: () => void): unknown;
}

/**
 * The one thing this module needs from the session service.
 *
 * ## Why this is not `Pick<SessionService, …>`
 *
 * `SessionLookup` in `./handler.ts` is `Pick<SessionService, 'list'>`, and this
 * would be written the same way but for one fact: `SessionService` has no
 * method that does this yet, so there is nothing to `Pick`.
 *
 * The three existing mutations are all wrong for a socket that just closed:
 *
 * - `heartbeat()` is the exact opposite. It returns a `stale` session to
 *   `active`, because a heartbeat is evidence contradicting the inference of
 *   staleness. Calling it here would mark a dead listener alive.
 * - `end()` is terminal. `ended` means a listener deliberately tore its session
 *   down, and it is never revived; a dropped connection is not that. The
 *   listener may reconnect in four seconds, and `hello` requires an active
 *   session, so ending one here would refuse the reconnection it is meant to
 *   survive.
 * - `sweep()` is time-based and would not touch the row for another sixty
 *   seconds, which is the delay this module exists to remove.
 *
 * So the port is declared here, structurally, and `../services/sessions.ts`
 * grows one method to satisfy it. `Pick<SessionService, 'markStale'>` will
 * satisfy this interface the moment it exists, with no change to this file.
 *
 * Writing the `UPDATE` here instead was considered and rejected. Session status
 * is not a column this module is entitled to an opinion about: the service owns
 * the compare-and-set discipline that makes its sweep lock-free, and the
 * database owns `sessions_ended_at_matches_status`, which a second writer with
 * its own idea of the state machine is well placed to violate. One writer for
 * one table is worth more than one task's convenience.
 */
export interface SessionStaleMarker {
  /**
   * Records that a session's listener is gone.
   *
   * The contract this module depends on, and what
   * `../services/sessions.ts` is asked to implement:
   *
   * - Moves `active` **or** `stale` to `stale` and sets `last_seen_at` to now.
   *   Marking an already-stale session stale again is a no-op that still
   *   refreshes the timestamp, so a reconnect-then-drop cycle does not age a
   *   session faster than the disconnections themselves.
   * - Leaves `ended` alone, and **does not throw for it**. A socket closing
   *   after `DELETE /sessions/:id` is the normal, correct shutdown order for
   *   `agentchat listen`, not an error; a `CONFLICT` there would make every
   *   clean exit log a failure. This is the one place its semantics differ from
   *   `heartbeat()`, which does throw `CONFLICT`, and the difference is that a
   *   heartbeat on an ended session is a client bug while a close on one is the
   *   client behaving properly.
   * - Is scoped to the caller like every other session mutation, so it cannot
   *   touch a session that is not theirs.
   *
   * @param request - The socket's own user and session, straight off its
   *   `SocketIdentity`.
   */
  markStale(request: { readonly userId: UserId; readonly sessionId: SessionId }): Promise<unknown>;

  /**
   * Records that a session's listener is still there.
   *
   * The counterpart of {@link SessionStaleMarker.markStale}, called from the
   * `pinged` hook for every client `ping` on a bound socket. The protocol
   * document promises that keeping `ping` flowing keeps a session present, and
   * until T-069 nothing wrote that promise to the row: the sweeper aged every
   * listener into `stale` a minute after `hello`, and discovery called its agent
   * offline while its socket went on delivering. What the service is asked to
   * do:
   *
   * - Move `active` or `stale` to `active` and set `last_seen_at` to now.
   * - Leave `ended` alone, and **do not throw for it**, for the same reason
   *   `markStale` does not: a `ping` between `DELETE /sessions/:id` and the
   *   socket closing is the normal shutdown order of `agentchat listen`.
   * - Be scoped to the caller like every other session mutation.
   *
   * @param request - The socket's own user and session, straight off its
   *   `SocketIdentity`.
   */
  touch(request: { readonly userId: UserId; readonly sessionId: SessionId }): Promise<unknown>;
}

/** What {@link createHeartbeat} needs. */
export interface HeartbeatOptions {
  /** How a closed socket's session is marked stale. See {@link SessionStaleMarker}. */
  readonly sessions: SessionStaleMarker;

  /** Where reaped sockets and unusual closes are reported. */
  readonly logger: SocketLogger;

  /**
   * The clock, injectable so the deadline is testable without waiting a minute.
   *
   * The same seam `./handler.ts` and `../services/sessions.ts` already use.
   */
  readonly now?: (() => number) | undefined;

  /** How often {@link HeartbeatService.sweep} runs. Defaults to {@link PING_INTERVAL_MS}. */
  readonly intervalMs?: number | undefined;

  /** Silence before a socket is reaped. Defaults to {@link PONG_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/**
 * Liveness for every socket on this process.
 *
 * It *is* a {@link ConnectionObserver}, in the same way `DeliveryService` is,
 * so the wiring composes the two rather than one calling the other. See
 * `composeConnectionObservers` in `../app.ts`.
 */
export interface HeartbeatService extends ConnectionObserver {
  /**
   * A bound socket sent a `ping`: its session is touched so presence keeps
   * counting it. The `pong` has already gone out, so a failure here is logged
   * and never closes the socket. See {@link SessionStaleMarker.touch}.
   */
  pinged(binding: SocketBinding): Promise<void>;

  /**
   * Starts watching a socket.
   *
   * Called by the transport adapter as soon as the upgrade completes, before
   * the handshake — an unauthenticated-then-abandoned socket is still a socket
   * to reclaim, and waiting for `hello` would leave the one connection most
   * likely to be junk unwatched.
   *
   * No handle comes back, unlike the registry's `register`. There is nothing
   * for a caller to remember to release: the socket's own `close` event is what
   * removes it, which is authoritative in a way a caller's discipline is not
   * and covers the close this module itself initiates.
   *
   * @param socket - The transport.
   */
  watch(socket: HeartbeatSocket): void;

  /**
   * Pings every watched socket, and destroys the ones that stopped answering.
   *
   * Public because the interval is not the only reasonable caller: it is what
   * the tests drive, against an injected clock, instead of waiting a real
   * minute. Idempotent, and safe after {@link HeartbeatService.stop}.
   *
   * @returns How many sockets it reaped.
   */
  sweep(): number;

  /**
   * The socket has gone; make its session say so.
   *
   * Runs only for sockets that completed a handshake, which is the whole point
   * — an unbound socket has no session to be honest about.
   *
   * @param binding - The socket that closed.
   * @param code - The close code it went out with.
   */
  closed(binding: SocketBinding, code: number): Promise<void>;

  /**
   * Stops the sweep.
   *
   * Called at shutdown, alongside closing the sockets themselves. Idempotent.
   * The interval is `unref`'d, so this is about stopping work that has become
   * pointless rather than about letting the process exit — that part is already
   * true whether or not anybody calls this.
   */
  stop(): void;

  /** How many sockets are being watched. For tests and for the shutdown log. */
  readonly size: number;
}

/** What the sweep remembers about one socket. */
interface Watched {
  /** When it last proved it was there. Seeded at {@link HeartbeatService.watch}. */
  lastSeen: number;
}

/**
 * Builds the heartbeat.
 *
 * ## What it deliberately does not do
 *
 * **It does not implement `pinged`.** A client `ping` frame is evidence of
 * life, and treating it as such is tempting. It is not done, for two reasons.
 * The hook carries a `SocketBinding`, not a socket, so using it would mean
 * keeping a second map from binding to socket purely to feed the first one —
 * coupling the two halves described in the module note, to cover a case they
 * already cover. And it would buy nothing: a client with enough of a runtime to
 * compose a `ping` frame has, necessarily, a WebSocket implementation
 * underneath it that answers control-frame pings automatically. There is no
 * client that sends application pings but fails to answer a protocol one.
 *
 * **It does not un-watch from `closed`.** The socket's own `close` event does
 * that, and it fires for sockets that never bound as well.
 *
 * @param options - The stale marker, the logger, and the injectable clock.
 * @returns The service, with its sweep already running.
 */
export function createHeartbeat(options: HeartbeatOptions): HeartbeatService {
  const { sessions, logger } = options;
  const now = options.now ?? (() => Date.now());
  const intervalMs = options.intervalMs ?? PING_INTERVAL_MS;
  const timeoutMs = options.timeoutMs ?? PONG_TIMEOUT_MS;

  const watched = new Map<HeartbeatSocket, Watched>();

  const timer = setInterval(() => {
    service.sweep();
  }, intervalMs);

  // A heartbeat is not a reason for a process to stay alive. Without this, a
  // test that builds a service and forgets to stop it hangs the run at the end
  // rather than failing, which is the most expensive kind of mistake to
  // diagnose because the failure names no test.
  timer.unref();

  const service: HeartbeatService = {
    get size(): number {
      return watched.size;
    },

    watch(socket: HeartbeatSocket): void {
      watched.set(socket, { lastSeen: now() });

      socket.on('pong', () => {
        const state = watched.get(socket);

        // Gone if the socket closed between the pong arriving and this running.
        // Re-adding it here would resurrect an entry nothing will ever remove.
        if (state !== undefined) {
          state.lastSeen = now();
        }
      });

      socket.on('close', () => {
        watched.delete(socket);
      });
    },

    sweep(): number {
      const deadline = now() - timeoutMs;
      let reaped = 0;

      // A copy, because `terminate()` may synchronously fire `close`, which
      // deletes from the map being walked.
      for (const [socket, state] of [...watched]) {
        if (state.lastSeen <= deadline) {
          watched.delete(socket);
          reaped += 1;

          logger.warn(
            { silentForMs: now() - state.lastSeen, timeoutMs },
            'websocket missed its heartbeat deadline; terminating it',
          );

          socket.terminate();
          continue;
        }

        socket.ping();
      }

      return reaped;
    },

    async pinged(binding: SocketBinding): Promise<void> {
      const { userId, sessionId } = binding.identity;

      try {
        await sessions.touch({ userId, sessionId });
      } catch (error: unknown) {
        // Logged, not rethrown. The `pong` has already been sent, the socket is
        // healthy, and a throwing hook would close it with INTERNAL_ERROR over
        // a bookkeeping failure. The cost of a lost touch is that presence may
        // age this session into `stale` a ping later than it should, which the
        // next `ping` corrects; the cost of a closed socket is a reconnect and
        // a replay for a listener that did nothing wrong.
        logger.error({ err: error, sessionId }, 'could not record a ping on a session');
      }
    },

    async closed(binding: SocketBinding, code: number): Promise<void> {
      const { userId, sessionId, agentId, projectId } = binding.identity;

      // Both end the session. Only one is worth a raised eyebrow: 1000 is a
      // listener that chose to leave, and anything else — 1006 from a peer that
      // vanished, 1011 from a hook that threw, one of the 44xx refusals — is a
      // listener that did not get to choose. Logging every disconnect at the
      // same level would bury the interesting ones under `Ctrl-C`.
      const detail = { sessionId, agentId, projectId, code };

      if (code === CloseCode.NORMAL) {
        logger.info(detail, 'listener disconnected');
      } else {
        logger.warn(detail, 'listener disconnected abnormally');
      }

      try {
        await sessions.markStale({ userId, sessionId });
      } catch (error: unknown) {
        // Logged, not rethrown. There is no socket left to close — this hook
        // runs *because* it is gone — so propagating could only make
        // `composeConnectionObservers` rethrow into a handshake that would try
        // to close it again.
        //
        // More to the point, correctness does not depend on this write. The
        // session sweeper ages an unmarked session to `stale` on its own within
        // a minute of its last heartbeat. This call is a latency improvement on
        // a guarantee that already exists, so a database blip during a
        // disconnect costs a slower presence update, not a wrong one.
        logger.error({ err: error, sessionId }, 'could not mark a closed session stale');
      }
    },

    stop(): void {
      clearInterval(timer);
    },
  };

  return service;
}
