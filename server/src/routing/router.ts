/**
 * "Deliver this frame to that agent, in that project" — as an interface, so
 * that *how* the sockets are found can change without any caller noticing.
 *
 * ## Why an interface at all
 *
 * Plan §4.3 makes the registry an in-process `Map`, and §8 makes multi-instance
 * fan-out over Postgres `LISTEN`/`NOTIFY` a v0.2 item. Those two sentences,
 * taken together, decide the deployment: with an in-process map as the only way
 * to find a socket, a message posted to instance B is undeliverable to a
 * listener attached to instance A, so the reference deployment has to pin to a
 * single server process. That is a *routing* limitation wearing a deployment's
 * clothes, and it is the reason this file exists.
 *
 * {@link Router} is therefore the whole point of T-307, not
 * `../websocket/registry.ts`. Callers — the messages service, the `hello`
 * replay, anything that will ever want to reach an agent — depend on `deliver`
 * and on nothing else. The registry is an implementation detail of
 * {@link createInProcessRouter}, and a caller that reached past the router into
 * the registry would be the thing that makes the cross-instance version a
 * rewrite instead of a constructor swap.
 *
 * ## What a cross-instance implementation looks like
 *
 * The interface was shaped by writing that implementation out, so it is worth
 * recording. `createNotifyRouter({ registry, pool, logger })` would:
 *
 * 1. Deliver locally first, exactly as {@link createInProcessRouter} does —
 *    every instance keeps a registry of *its own* sockets, and the local case
 *    must not pay for a database round trip.
 * 2. `NOTIFY agentchat_route, '<routeKey>|<messageId>'` for the other
 *    instances. The payload carries identifiers, never the message: Postgres
 *    caps a notification at 8000 bytes and messages run to a megabyte (D10), so
 *    a peer re-reads the row it was told about.
 * 3. On its own `LISTEN` connection, take a notification, look up
 *    {@link SocketRegistry.socketsFor} for the key, and deliver — the same
 *    local fan-out, entered from the network instead of from a call.
 * 4. `close` unlistens and returns the connection.
 *
 * Two properties of {@link DeliveryOutcome} exist because of step 3. It reports
 * *sessions*, not a count, because `deliveries` rows are keyed by session and
 * each instance can only write the ones it performed itself. And it reports
 * only what this instance did, which is why the field is documented as local:
 * an outcome that pretended to describe the fleet would be a lie the moment
 * there were two instances, and callers would have built on it in the meantime.
 * Nothing is lost, because `message_inbox` — not this return value — is what
 * makes delivery at-least-once (Plan §4.4). A frame nobody was there to take is
 * a row that stays `pending` and is replayed on the next `hello`.
 *
 * `deliver` returns a promise for the same reason: an in-process fan-out is
 * synchronous and resolves immediately, but a `NOTIFY` is I/O, and a signature
 * that had to grow an `await` later would be exactly the caller-visible change
 * this interface exists to avoid.
 *
 * ## One socket's failure is not another's
 *
 * A fan-out writes to sockets that are closing while it writes to them. That is
 * not an exceptional condition — a listener quits, its machine sleeps, a
 * network drops — and the rule that follows is absolute: a `send` that throws
 * costs that socket its registration and nothing else. Every recipient is
 * written to inside its own `try`, over a snapshot taken before the first
 * write, so neither a throwing socket nor a close triggered by a write can
 * remove a recipient from the fan-out that is already under way.
 *
 * ## Back-pressure, honestly
 *
 * **Today:** `send` hands bytes to the transport and returns. `ws` queues what
 * the peer has not read into its own buffer, so a slow consumer never blocks
 * the loop and never delays another recipient — it grows the heap instead.
 * There is no ceiling on that growth in this process.
 *
 * **Under load:** a listener that stops reading — suspended laptop, a runtime
 * paused at a breakpoint, a TCP window that never opens — accumulates every
 * frame addressed to it, at up to {@link MAX_FRAME_BYTES} apiece. Enough of
 * those and the process dies of memory pressure, taking every *healthy* socket
 * with it. That is the failure mode worth naming: back-pressure here is not a
 * slow-delivery problem, it is an availability problem for everyone else.
 *
 * **The fix, when it is due:** the ceiling belongs on the socket, not on the
 * fan-out. When a socket's buffer passes a high-water mark, close it. The
 * listener reconnects and its `hello` replays the inbox, so nothing is lost —
 * at-least-once is exactly what makes dropping a stalled consumer safe, and it
 * is why buffering for it indefinitely buys nothing. This module goes one step
 * short of that: it reads {@link DeliverySocket.bufferedBytes} when the adapter
 * exposes it and warns past {@link BUFFER_WARNING_BYTES}, so the condition is
 * visible in the logs before it is a post-mortem. It does not close, because
 * choosing the threshold at which a listener is declared unreachable is a
 * policy decision with its own task, not a side effect of adding a registry.
 *
 * @module
 */

import type { SessionId } from '@stackgrid/protocol';
import type { ServerFrame } from '../websocket/frames.js';
import { MAX_FRAME_BYTES } from '../websocket/frames.js';
import type { SocketLogger } from '../websocket/handler.js';
import type { DeliverySocket, RouteTarget, SocketRegistry } from '../websocket/registry.js';
import { routeKey } from '../websocket/registry.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Queued bytes on one socket past which delivery says so in the log.
 *
 * Four frames' worth. Small enough that a genuinely stalled peer trips it long
 * before memory is a problem, large enough that a burst of replayed messages to
 * a healthy listener does not. Nothing branches on it beyond the warning; see
 * the back-pressure note above for why the threshold that *closes* a socket is
 * a separate decision.
 */
export const BUFFER_WARNING_BYTES = 4 * MAX_FRAME_BYTES;

// ---------------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------------

/**
 * What one call to {@link Router.deliver} achieved **on this instance**.
 *
 * Sessions rather than counts, and local rather than global: see the module
 * note. A caller wanting "was this delivered at all" asks
 * `delivered.length > 0`, and a caller wanting durability asks
 * `message_inbox`, which is the only thing that can answer it.
 */
export interface DeliveryOutcome {
  /**
   * The sessions whose sockets took the frame.
   *
   * One entry per socket written to, so an agent listening twice from one
   * session — unusual, but nothing forbids it — appears twice, and a caller
   * writing one `deliveries` row per delivery writes two.
   */
  readonly delivered: readonly SessionId[];

  /**
   * The sessions whose sockets threw while being written to.
   *
   * Those sockets are no longer registered: a write that fails means the peer
   * is gone, and the connection's own `closed` hook may never run if the
   * transport has already given up on it.
   */
  readonly failed: readonly SessionId[];
}

/**
 * Delivery, separated from how sockets are found.
 *
 * The one interface the rest of the server should hold. See the module note for
 * the cross-instance implementation this shape was designed against.
 */
export interface Router {
  /**
   * Sends a frame to every socket serving an agent in a project.
   *
   * Never rejects. A recipient that cannot be written to is reported in
   * {@link DeliveryOutcome.failed}, because from the caller's point of view a
   * departed listener is an outcome and not a fault.
   *
   * @param target - The agent and project being addressed.
   * @param frame - The frame to send. Opaque here: routing has no opinion about
   *   what a message means, and a `type` that carried one would be a different
   *   product (Plan §4.2).
   * @returns What this instance delivered.
   */
  deliver(target: RouteTarget, frame: ServerFrame): Promise<DeliveryOutcome>;

  /**
   * Stops routing, for process shutdown.
   *
   * Idempotent. After it resolves, {@link Router.deliver} delivers to nobody.
   *
   * @returns When the router has released whatever it held.
   */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// The in-process implementation
// ---------------------------------------------------------------------------

/** What {@link createInProcessRouter} needs. */
export interface InProcessRouterOptions {
  /** The sockets this process is serving. */
  readonly registry: SocketRegistry;

  /** Where delivery failures and back-pressure warnings go. */
  readonly logger: SocketLogger;
}

/** Nothing delivered, nothing failed. Shared so the empty case allocates once. */
const NOTHING_DELIVERED: DeliveryOutcome = Object.freeze({
  delivered: Object.freeze([]),
  failed: Object.freeze([]),
});

/**
 * The v0.1 router: fan-out over one process's own registry.
 *
 * @param options - The registry to deliver through, and a logger.
 * @returns A router.
 */
export function createInProcessRouter(options: InProcessRouterOptions): Router {
  const { registry, logger } = options;

  /** Set by {@link Router.close}. Nothing is delivered afterwards. */
  let closed = false;

  /**
   * Writes one frame to one socket.
   *
   * @param socket - The recipient.
   * @param frame - What to send.
   * @returns Whether the transport took it.
   */
  function sendTo(socket: DeliverySocket, frame: ServerFrame): boolean {
    const { identity } = socket;

    const buffered = socket.bufferedBytes;
    if (buffered !== undefined && buffered > BUFFER_WARNING_BYTES) {
      // Not a refusal: the frame still goes, because the inbox — not this
      // check — decides what a listener owes, and dropping a delivery here
      // would only mean replaying it later. This is the operator's warning
      // that a peer has stopped reading. See the module note.
      logger.warn(
        {
          sessionId: identity.sessionId,
          agentId: identity.agentId,
          projectId: identity.projectId,
          bufferedBytes: buffered,
        },
        'websocket consumer is not keeping up',
      );
    }

    try {
      socket.send(frame);
      return true;
    } catch (error: unknown) {
      logger.info(
        {
          sessionId: identity.sessionId,
          agentId: identity.agentId,
          projectId: identity.projectId,
          err: error,
        },
        'websocket delivery failed; dropping socket',
      );
      return false;
    }
  }

  return {
    deliver(target: RouteTarget, frame: ServerFrame): Promise<DeliveryOutcome> {
      if (closed) {
        // Shutdown is not the caller's mistake, and it is not a failed request:
        // the message is already durable, its inbox row is still `pending`, and
        // the listener collects it on its next `hello`. Turning a race with
        // SIGTERM into a 500 would report a loss that did not happen.
        logger.info(
          { agentId: target.agentId, projectId: target.projectId },
          'delivery skipped; router is closed',
        );
        return Promise.resolve(NOTHING_DELIVERED);
      }

      // Snapshot before the first write. A `send` can close a socket, a close
      // deregisters it, and iterating the live set would then skip whichever
      // recipient the iterator was about to reach.
      const sockets = registry.socketsFor(target);
      if (sockets.length === 0) {
        return Promise.resolve(NOTHING_DELIVERED);
      }

      const delivered: SessionId[] = [];
      const failed: SessionId[] = [];

      for (const socket of sockets) {
        if (sendTo(socket, frame)) {
          delivered.push(socket.identity.sessionId);
        } else {
          failed.push(socket.identity.sessionId);
          registry.remove(socket);
        }
      }

      if (failed.length > 0) {
        logger.warn(
          {
            key: routeKey(target),
            delivered: delivered.length,
            failed: failed.length,
          },
          'websocket delivery dropped sockets',
        );
      }

      return Promise.resolve({ delivered, failed });
    },

    close(): Promise<void> {
      if (closed) {
        return Promise.resolve();
      }
      closed = true;

      // The transport is closing every connection, but whether each one's
      // `closed` hook still runs depends on how abrupt the shutdown is. This is
      // the one call that leaves nothing behind either way; outstanding
      // registrations stay safe to release.
      const forgotten = registry.clear();
      if (forgotten > 0) {
        logger.info({ sockets: forgotten }, 'router closed; registry cleared');
      }

      return Promise.resolve();
    },
  };
}
