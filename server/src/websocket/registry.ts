/**
 * Which sockets are serving which `(agent, project)` pair — and nothing else.
 *
 * Plan §4.3 specifies the registry as `Map<agentId:projectId, Set<Socket>>`.
 * This module is that sentence made executable, kept deliberately smaller than
 * it is tempting to make it.
 *
 * ## Why the key is a pair and the value is a set
 *
 * A message is addressed to an agent *in a project*; it is not addressed to a
 * session, a machine, or a socket. Everything downstream of that addressing
 * decision follows from the value being a set rather than a single socket: one
 * agent may run `agentchat listen` on a laptop and a build box at the same
 * time, and both of those listeners are the same recipient. That is the normal
 * case, not an edge case, and it is why nothing here has a notion of "the"
 * socket for an agent, or of a newer registration displacing an older one.
 *
 * The two halves of the key are both required. An agent id alone would deliver
 * a message across a project boundary — the one authorization invariant Plan §2
 * is most explicit about — and a project id alone would broadcast.
 *
 * ## What this module deliberately does not know
 *
 * **Sessions.** {@link DeliverySocket} carries a {@link SocketIdentity} because
 * `deliveries` rows are keyed by session (Plan §2), so whatever delivers has to
 * be told which session took a frame. But nothing here reads a session record,
 * checks a status, or asks the database anything. T-306 assembles the identity
 * during the `hello` — the pair is already resolved and validated by the time a
 * socket reaches this map — and re-deriving it here would be a second opinion
 * about a question already answered.
 *
 * **Presence.** Membership of this map is *not* the definition of online. That
 * definition is `activeSessionPredicate()` in `../services/sessions.ts`, which
 * T-302 exported precisely so that discovery, the registry and anything else
 * asking "is this agent reachable" share one expression instead of three copies
 * of `status = 'active'`. A registry lookup answers a narrower question — "is
 * there a socket on *this process* right now" — and the moment there is a
 * second server instance the two answers diverge. Anything reporting presence
 * to a user must use the predicate; anything delivering bytes uses this map.
 *
 * **Delivery.** Finding sockets and writing to them are separate jobs, split
 * across this module and `../routing/router.ts`. See that module for why.
 *
 * ## Removal
 *
 * {@link SocketRegistry.register} hands back a {@link Registration} rather than
 * expecting the caller to present the socket again later. A handle cannot
 * remove the wrong socket, cannot be defeated by a socket object that compares
 * equal to another, and is idempotent, which matters because a socket that
 * errors and then closes produces two removals for one connection. Releasing a
 * handle twice, or releasing one after {@link SocketRegistry.clear}, is a
 * no-op — and specifically it does not disturb a *different* socket that has
 * since registered under the same key.
 *
 * The map holds no empty sets. A key whose last socket is released is deleted,
 * so a process that has served a million short-lived connections holds no more
 * memory than one that has served none. That is the leak this module's tests
 * cycle a thousand connections to disprove, rather than asserting that a single
 * removal works.
 *
 * @module
 */

import type { AgentId, ProjectId } from '@agentchat/protocol';
import type { ServerFrame, SocketIdentity } from './frames.js';

// ---------------------------------------------------------------------------
// Addressing
// ---------------------------------------------------------------------------

/**
 * Where a delivery is addressed: an agent, in a project.
 *
 * A structural type rather than a class, so a {@link SocketIdentity}, a session
 * record and a message row are all targets without anything converting between
 * them.
 */
export interface RouteTarget {
  /** The recipient agent. */
  readonly agentId: AgentId;

  /** The project the delivery happens in. Never optional; see the module note. */
  readonly projectId: ProjectId;
}

/**
 * The string form of a {@link RouteTarget}.
 *
 * A plain string, not a branded type, because it is going to be a Postgres
 * `NOTIFY` payload the day this becomes cross-instance and a brand would only
 * have to be stripped at that boundary.
 */
export type RouteKey = string;

/**
 * What separates the two halves of a {@link RouteKey}.
 *
 * Unambiguous because identifiers are `agt_` and `prj_` prefixes over a
 * hyphenated UUID (`packages/protocol`'s `ids.ts`), and a colon appears in
 * neither. Exported so a cross-instance implementation splitting a key back
 * apart uses this constant rather than a literal of its own.
 */
export const ROUTE_KEY_SEPARATOR = ':';

/**
 * Builds the map key for a target.
 *
 * @param target - The agent and project being addressed.
 * @returns The key both halves of the routing layer index on.
 */
export function routeKey(target: RouteTarget): RouteKey {
  return `${target.agentId}${ROUTE_KEY_SEPARATOR}${target.projectId}`;
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/**
 * A socket, reduced to what delivery does with it.
 *
 * `SocketBinding` from `./handler.ts` satisfies this structurally, so the
 * observer that registers a bound socket passes the binding through unchanged
 * and no adapter object exists to go stale.
 *
 * Narrow on purpose: there is no `close` here. A registry able to close sockets
 * would sooner or later be the thing that closes them, and the handshake module
 * owns a socket's lifetime from its first frame to its last. That is not only a
 * tidiness argument: the one condition that *does* require closing a socket
 * from below — a peer that has stopped reading — is handled by
 * `MAX_BUFFERED_BYTES` in `./handler.ts`, on the socket itself, and neither
 * this module nor the router had to grow a `close` for it.
 */
export interface DeliverySocket {
  /** The user, session, agent and project this socket serves. */
  readonly identity: SocketIdentity;

  /**
   * Sends one frame.
   *
   * May throw. A socket that has already closed is the common case and is not
   * an error anybody has to handle; see `../routing/router.ts`.
   */
  send(frame: ServerFrame): void;

  /**
   * Bytes queued in the transport that the peer has not yet read, if the
   * adapter exposes it (`ws` calls it `bufferedAmount`).
   *
   * Optional because it is a property of the transport rather than of this
   * protocol, and reading it is the only visibility anything has into a slow
   * consumer. See the back-pressure note in `../routing/router.ts` for the
   * warning it drives, and `MAX_BUFFERED_BYTES` in `./handler.ts` for the
   * ceiling past which the socket is closed rather than buffered for.
   *
   * Read on every delivery, so an implementation must answer with the live
   * figure. A cached one would report a peer as caught up long after it stopped
   * reading, which is the whole condition both of those exist to catch.
   */
  readonly bufferedBytes?: number | undefined;
}

/**
 * The right to remove one socket, handed out by
 * {@link SocketRegistry.register}.
 *
 * Held by the connection it belongs to, released from the `closed` hook.
 */
export interface Registration {
  /** The key this socket was filed under. Logging and tests; not required to release. */
  readonly key: RouteKey;

  /**
   * Removes the socket. Idempotent, and safe after the registry was cleared.
   */
  release(): void;
}

/**
 * The sockets this process is serving, indexed by `(agent, project)`.
 *
 * Deliberately not an interface anyone implements twice: the cross-instance
 * story lives in the `Router` interface, not here. A second process still has
 * its own local registry of its own local sockets; what changes is who tells it
 * to deliver.
 */
export interface SocketRegistry {
  /**
   * Files a bound socket under its agent and project.
   *
   * @param socket - The socket, carrying the identity T-306 assembled.
   * @returns The handle that removes it again.
   */
  register(socket: DeliverySocket): Registration;

  /**
   * The sockets serving a target, as a snapshot.
   *
   * A copy rather than the live set, because delivering to a socket can close
   * it, a close removes it, and mutating a `Set` while iterating it is how a
   * fan-out silently skips a recipient.
   *
   * @param target - The agent and project being addressed.
   * @returns Every socket currently serving that pair. Empty if none.
   */
  socketsFor(target: RouteTarget): readonly DeliverySocket[];

  /**
   * Removes a socket without its handle.
   *
   * For the one caller that has the socket but not the registration: delivery,
   * dropping a socket whose `send` threw.
   *
   * @param socket - The socket to remove.
   * @returns Whether it was registered.
   */
  remove(socket: DeliverySocket): boolean;

  /** How many sockets are registered, across every key. */
  readonly size: number;

  /** How many distinct `(agent, project)` pairs have at least one socket. */
  readonly routeCount: number;

  /**
   * Forgets every socket.
   *
   * The process-shutdown path: the transport is closing every connection, and
   * whether each one's `closed` hook still runs is up to how abrupt the
   * shutdown is. Outstanding {@link Registration}s stay safe to release.
   *
   * @returns How many sockets were forgotten.
   */
  clear(): number;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Builds an empty registry.
 *
 * @returns A registry with no sockets in it.
 */
export function createSocketRegistry(): SocketRegistry {
  /** Sockets by route key. Never holds an empty set; see the module note. */
  const routes = new Map<RouteKey, Set<DeliverySocket>>();

  /** How many sockets are in `routes`, kept rather than recomputed. */
  let count = 0;

  /**
   * Drops a socket from one key's set, and the key with it if it empties.
   *
   * The `routes.get(key) !== sockets` guard is what makes a late release safe,
   * and it is the whole of that safety. A set stops being the registry's the
   * moment it empties (the key is deleted) or the registry is cleared, and a
   * handle released afterwards still points at it. Deleting from an orphaned
   * set would take `count` below zero and, if the pair had since been
   * registered again, would look like the *new* socket's key was empty.
   * Refusing to touch a set the map no longer holds covers both.
   *
   * @param key - The key the socket was filed under.
   * @param sockets - The exact set it was added to.
   * @param socket - The socket to drop.
   * @returns Whether the socket was still registered.
   */
  function drop(key: RouteKey, sockets: Set<DeliverySocket>, socket: DeliverySocket): boolean {
    if (routes.get(key) !== sockets || !sockets.delete(socket)) {
      return false;
    }

    count -= 1;
    if (sockets.size === 0) {
      routes.delete(key);
    }

    return true;
  }

  return {
    register(socket: DeliverySocket): Registration {
      const key = routeKey(socket.identity);
      let sockets = routes.get(key);
      if (sockets === undefined) {
        sockets = new Set<DeliverySocket>();
        routes.set(key, sockets);
      }

      // A set, so registering the same socket twice is not two entries to
      // release. The handshake refuses a second `hello`, so this should not
      // happen; a registry that double-counted it would leak on a bug it is
      // in no position to diagnose.
      if (!sockets.has(socket)) {
        sockets.add(socket);
        count += 1;
      }

      const owner = sockets;
      let released = false;

      return {
        key,
        release(): void {
          if (released) {
            return;
          }
          released = true;
          drop(key, owner, socket);
        },
      };
    },

    socketsFor(target: RouteTarget): readonly DeliverySocket[] {
      const sockets = routes.get(routeKey(target));
      return sockets === undefined ? [] : [...sockets];
    },

    remove(socket: DeliverySocket): boolean {
      const key = routeKey(socket.identity);
      const sockets = routes.get(key);
      return sockets === undefined ? false : drop(key, sockets, socket);
    },

    get size(): number {
      return count;
    },

    get routeCount(): number {
      return routes.size;
    },

    clear(): number {
      const forgotten = count;
      routes.clear();
      count = 0;
      return forgotten;
    },
  };
}
