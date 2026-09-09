/**
 * A controllable TCP relay, which is how this suite breaks things.
 *
 * ## Why a proxy and not a kill
 *
 * The failures T-509 exists to attack are failures of the *connection*, and
 * most of them cannot be produced by stopping a process. Killing a listener
 * closes its socket cleanly at the TCP level; stopping PostgreSQL disturbs
 * every other suite sharing it; and nothing at all reproduces "the peer has
 * stopped reading but the connection is still up", which is the exact condition
 * §9.8's 16 MiB ceiling is written for.
 *
 * So every connection in this suite runs through a relay this process owns:
 *
 * ```text
 *   agentchat ──▶ [client proxy] ──▶ server ──▶ [database proxy] ──▶ PostgreSQL
 * ```
 *
 * From either end it is an ordinary TCP connection. From here it is four verbs:
 *
 * - {@link TcpProxy.cut} — destroy the live connections with a reset. The peer
 *   sees the connection vanish with no FIN and no WebSocket close frame, which
 *   is what a crashed middlebox, a dropped Wi-Fi association or a killed
 *   container does and what an orderly `close()` never does.
 * - {@link TcpProxy.stall} — stop reading from the server side of the live
 *   connections. Nothing is lost and nothing is closed: the kernel receive
 *   window closes, back-pressure reaches the server, and the server's own
 *   send buffer starts to fill. That is a listener that has stopped reading.
 * - {@link TcpProxy.refuse} — reset new connections on arrival, so a restart
 *   or a reconnect can be held off for as long as a test needs.
 * - {@link TcpProxy.retarget} — point later connections at a different port,
 *   which is what lets a server be killed and replaced while the address its
 *   clients hold stays the same.
 *
 * ## The address the clients hold never moves
 *
 * `agentchat login` writes the server's URL into the credentials file, so a
 * server restarted on a different ephemeral port would be a server its own
 * clients could not find — and a *fixed* port would be a collision between the
 * several agents who run this repository's suites at once. The relay resolves
 * both: it owns one ephemeral port for the whole file, the server behind it
 * keeps asking the operating system for a free one, and a restart is a
 * {@link TcpProxy.retarget}.
 *
 * ## Existing connections and later ones are separated on purpose
 *
 * `cut` and `stall` act on the connections that are open when they are called,
 * and never on connections opened afterwards. That distinction is what makes
 * the mid-delivery tests possible: a long-lived listener socket can be stalled
 * or destroyed while `agentchat send`, which dials a fresh connection for its
 * one HTTP request, still reaches the server through the same relay.
 *
 * @module
 */

import { type AddressInfo, connect, createServer, type Server, type Socket } from 'node:net';

/** One relayed connection: what the client dialled, and what it reached. */
interface Relay {
  /** The socket the client is holding. */
  readonly downstream: Socket;
  /** The socket to the server. */
  readonly upstream: Socket;
  /** Whether {@link TcpProxy.stall} has stopped this one being drained. */
  stalled: boolean;
}

/** A relay whose behaviour a test can change while traffic is flowing. */
export interface TcpProxy {
  /** The loopback port clients connect to. Fixed for the proxy's lifetime. */
  readonly port: number;
  /** `http://127.0.0.1:<port>`, which is what `agentchat login --server` wants. */
  readonly origin: string;
  /** How many relayed connections are open right now. */
  connectionCount(): number;
  /** Sends later connections to `port` instead. Open ones are not touched. */
  retarget(port: number): void;
  /**
   * Destroys every open connection with a reset.
   *
   * A reset rather than a close: `destroy()` alone leaves Node free to send a
   * FIN, and a FIN is an orderly shutdown, which is the thing this method
   * exists not to be.
   *
   * @returns How many connections were destroyed.
   */
  cut(): number;
  /**
   * Stops draining the server side of every open connection.
   *
   * @returns How many connections were stalled.
   */
  stall(): number;
  /** Drains everything {@link TcpProxy.stall} stopped. */
  resume(): void;
  /** Whether an incoming connection is reset on arrival instead of relayed. */
  refuse(on: boolean): void;
  /** Closes the listener and every connection under it. */
  close(): Promise<void>;
}

/** What {@link startTcpProxy} needs to know. */
export interface TcpProxyOptions {
  /** The port to relay to initially. */
  readonly targetPort: number;
  /** The host to relay to. Loopback unless a test says otherwise. */
  readonly targetHost?: string;
}

/**
 * Starts a relay on an ephemeral loopback port.
 *
 * @param options - Where to relay to.
 * @returns The running relay. The caller must {@link TcpProxy.close} it.
 * @throws If the listening socket cannot be bound.
 */
export async function startTcpProxy(options: TcpProxyOptions): Promise<TcpProxy> {
  const host = options.targetHost ?? '127.0.0.1';
  let targetPort = options.targetPort;
  let refusing = false;
  const relays = new Set<Relay>();

  const server: Server = createServer({ noDelay: true }, (downstream) => {
    if (refusing) {
      downstream.resetAndDestroy();
      return;
    }

    const upstream = connect({ host, port: targetPort, noDelay: true });
    const relay: Relay = { downstream, upstream, stalled: false };
    relays.add(relay);

    // Both directions are forwarded by hand rather than with `pipe`, because
    // `stall` has to be able to stop one of them without tearing anything down,
    // and `pipe`'s flow control is exactly what it would have to fight.
    downstream.on('data', (chunk: Buffer) => {
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => {
      downstream.write(chunk);
    });

    // A shutdown of either half ends the other, so an orderly close still looks
    // orderly through the relay. Only `cut` produces a reset.
    const end = (): void => {
      relays.delete(relay);
      downstream.destroy();
      upstream.destroy();
    };
    downstream.on('end', end);
    upstream.on('end', end);
    downstream.on('close', end);
    upstream.on('close', end);

    // A reset from either side reaches the other as an error rather than an
    // event, and an unhandled `error` on a socket is an uncaught exception that
    // would fail the run in a way that has nothing to do with the test.
    downstream.on('error', end);
    upstream.on('error', end);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;

  /** Destroys every open relay with a reset. See {@link TcpProxy.cut}. */
  const cutAll = (): number => {
    const open = [...relays];
    relays.clear();
    for (const relay of open) {
      relay.downstream.resetAndDestroy();
      relay.upstream.resetAndDestroy();
    }
    return open.length;
  };

  return {
    port,
    origin: `http://127.0.0.1:${String(port)}`,
    connectionCount: () => relays.size,
    retarget(next: number): void {
      targetPort = next;
    },
    cut: cutAll,
    stall(): number {
      let stalled = 0;
      for (const relay of relays) {
        if (!relay.stalled) {
          relay.stalled = true;
          relay.upstream.pause();
          stalled += 1;
        }
      }
      return stalled;
    },
    resume(): void {
      for (const relay of relays) {
        if (relay.stalled) {
          relay.stalled = false;
          relay.upstream.resume();
        }
      }
    },
    refuse(on: boolean): void {
      refusing = on;
    },
    async close(): Promise<void> {
      refusing = true;
      cutAll();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
