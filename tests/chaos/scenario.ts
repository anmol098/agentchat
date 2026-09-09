/**
 * The world each chaos test file breaks: two people, two agents, one project,
 * and every connection running through something this process can sever.
 *
 * ```text
 *   agentchat (alice) ─┐
 *   agentchat (bob)   ─┼─▶ client relay ──▶ server ──▶ database relay ──▶ PostgreSQL
 *   agentchat listen  ─┘
 * ```
 *
 * The setup is deliberately the same one `../e2e/delivery.integration.test.ts`
 * builds, through the same real device flow, the same real invite and the same
 * real `agentchat` processes — a resilience suite that started from a different
 * world would be proving things about that world instead. What is added is the
 * two relays and a server that can be killed and replaced without its clients
 * losing the address they were given.
 *
 * ## Why every assertion names a message identifier
 *
 * These tests share one database with each other and with every previous run
 * against it, and several of them deliberately leave messages unacknowledged —
 * that is what a failed delivery *is*. So nothing here asserts on a count of
 * pending messages or on an inbox being empty. Every wait and every assertion
 * names the identifier it is about, exactly as T-314 established.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';

import {
  applyMigrations,
  type CliWorkspace,
  type Listener,
  removeWorkspace,
  startListener,
  waitUntilConnected,
} from '../e2e/harness.js';
import { type FakeIdentityProvider, startIdentityProvider } from '../e2e/identity-provider.js';
import {
  type ChaosServer,
  createWorkspace,
  runCli,
  runCliJson,
  startServerProcess,
  startTcpProxy,
  type TcpProxy,
  waitFor,
} from './harness.js';

/** The runtime name these listeners register under (D14 requires one). */
export const RUNTIME = 'chaos-harness';

/** How long to wait for something that is expected to have happened by now. */
export const SETTLE_TIMEOUT_MS = 30_000;

/** A signed-in person with an agent in the project. */
export interface ChaosActor {
  /** Their configuration home and working directory. */
  readonly workspace: CliWorkspace;
  /** Their AgentChat username, which is the provider login lowercased. */
  readonly username: string;
  /** The address other agents send to, e.g. `@chaos-alice-1a2b/backend`. */
  readonly address: string;
}

/** Shapes of the `--json` documents these suites read. Only the read fields. */
export interface ProjectDocument {
  readonly project: { readonly id: string; readonly slug: string };
}
/** The `project invite` document. */
export interface InviteDocument {
  readonly code: string;
}
/** The `send` receipt. */
export interface SendDocument {
  readonly messageId: string;
  readonly conversationId: string;
  readonly duplicate: boolean;
}
/** The `inbox` listing. */
export interface InboxDocument {
  readonly agent: { readonly address: string };
  readonly items: readonly {
    readonly messageId: string;
    readonly sender: string | null;
    readonly content: string;
  }[];
}
/** The `ack` result. */
export interface AckDocument {
  readonly items: readonly {
    readonly messageId: string;
    readonly acknowledged: boolean;
    readonly alreadyAcknowledged: boolean;
    readonly acknowledgedAt: string | null;
  }[];
}
/** The `agents` roster. */
export interface AgentsDocument {
  readonly items: readonly {
    readonly address: string;
    readonly online: boolean;
    readonly sessions: number;
  }[];
}

/** Everything a chaos test file needs, and the levers it breaks things with. */
export interface ChaosScenario {
  /** The relay every `agentchat` process talks to. Its port never moves. */
  readonly clientRelay: TcpProxy;
  /** The relay the server reaches PostgreSQL through. */
  readonly databaseRelay: TcpProxy;
  /** The server process running right now. Replaced by {@link restartServer}. */
  server(): ChaosServer;
  /** The sender. */
  readonly alice: ChaosActor;
  /** The recipient. */
  readonly bob: ChaosActor;

  /**
   * Ends the server and starts another behind the same client-facing address.
   *
   * @param options - `signal` defaults to `SIGKILL`, which is the interesting
   *   one: no shutdown path runs, so nothing is drained, no socket is closed
   *   politely, and no session is ended. `clockShiftMs` moves the replacement's
   *   clock (see `./clock-shift.mjs`).
   */
  restartServer(options?: {
    readonly signal?: NodeJS.Signals;
    readonly clockShiftMs?: number;
  }): Promise<void>;

  /**
   * Replaces the server **without an outage**, the way a rolling deploy does.
   *
   * The replacement is listening and the relay is pointed at it before the old
   * process is asked to stop, so a client that reconnects at any instant during
   * the swap reaches a server rather than a closed port.
   *
   * This exists because {@link ChaosScenario.restartServer} deliberately
   * produces an outage, and an outage is a *second* failure. A test whose
   * subject is the access token expiring cannot tell "the client refreshed" from
   * "the client survived a gap in service" if it is given both at once, and the
   * reference client spends its one refresh per streak on whichever comes first
   * (`packages/client/src/websocket/listener.ts`, `#refreshedThisStreak`). One
   * failure at a time is what makes the result mean something.
   *
   * @param options - `clockShiftMs` moves the replacement's clock, which is how
   *   an access token is expired without waiting an hour. See `./clock-shift.mjs`.
   */
  rotateServer(options?: { readonly clockShiftMs?: number }): Promise<void>;

  /** Starts a listener for `actor` and registers it for teardown. */
  listen(actor: ChaosActor, argv?: readonly string[]): Listener;
  /** Starts a listener and waits until its socket is up. */
  listenConnected(actor: ChaosActor, argv?: readonly string[]): Promise<Listener>;
  /** Stops every listener this scenario started. Safe to call twice. */
  stopListeners(signal?: NodeJS.Signals): Promise<void>;

  /** Sends one message from Alice to Bob. */
  send(content: string, options?: readonly string[]): Promise<SendDocument>;
  /** Bob's pending inbox, as the CLI reports it. */
  inbox(): Promise<InboxDocument>;
  /** Whether Bob is still owed `messageId`. */
  isPending(messageId: string): Promise<boolean>;
  /** Waits until Bob is no longer owed `messageId`. */
  waitUntilAcknowledged(messageId: string): Promise<void>;
  /** Acknowledges as Bob, returning what the server said. */
  ack(messageId: string): Promise<AckDocument>;
  /** Waits until the roster reports Bob with `sessions` live sessions. */
  waitForSessions(count: number): Promise<void>;

  /** Stops everything and removes both workspaces. */
  close(): Promise<void>;
}

/** Replaces the host and port of a connection string with a relay's. */
function throughRelay(databaseUrl: string, relay: TcpProxy): string {
  const url = new URL(databaseUrl);
  url.hostname = '127.0.0.1';
  url.port = String(relay.port);
  return url.href;
}

/**
 * Builds the world.
 *
 * Everything here is the software this project ships: the shipped migration
 * runner applies the schema, the built server runs as its own process, and each
 * `agentchat` command is a process reading its own configuration off disk. The
 * two exceptions are documented where they are made — the identity provider in
 * `../e2e/identity-provider.ts`, and the clock in `./clock-shift.mjs`.
 *
 * @param name - Short label, used in usernames and temporary directory names,
 *   so a leaked directory or a stranded row says which file left it.
 * @returns The scenario. The caller must {@link ChaosScenario.close} it.
 * @throws If any step of the setup fails, with the failing command's output.
 */
export async function createScenario(name: string): Promise<ChaosScenario> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl.trim() === '') {
    throw new Error('DATABASE_URL is unset; the integration project should have refused to start.');
  }

  // Migrations go straight to PostgreSQL rather than through the relay. The
  // relay exists to be broken; a schema half-applied through a severed
  // connection would be a broken fixture rather than a test result.
  await applyMigrations();

  const identityProvider = await startIdentityProvider();
  const target = new URL(databaseUrl);
  const databaseRelay = await startTcpProxy({
    targetHost: target.hostname,
    targetPort: Number(target.port === '' ? '5432' : target.port),
  });

  let server = await startServerProcess({
    identityOrigin: identityProvider.origin,
    databaseUrl: throughRelay(databaseUrl, databaseRelay),
  });
  const clientRelay = await startTcpProxy({ targetPort: server.port });

  const runId = randomBytes(4).toString('hex');
  const openListeners: Listener[] = [];

  /** Signs a new person in through the real device flow. */
  const signIn = async (handle: string): Promise<{ workspace: CliWorkspace; username: string }> => {
    const username = `chaos-${name}-${handle}-${runId}`;
    const workspace = await createWorkspace(`${name}-${handle}`);

    identityProvider.enqueue({
      id: `chaos-${name}-${handle}-${runId}`,
      login: username,
      name: `${handle} (chaos)`,
      email: `${handle}@example.invalid`,
    });

    const login = await runCli(workspace, ['--json', 'login', '--server', clientRelay.origin]);
    if (login.code !== 0) {
      throw new Error(
        `login failed for ${handle}.\nstdout: ${login.stdout}\nstderr: ${login.stderr}\n` +
          `server problems:\n${server.problems()}`,
      );
    }

    return { workspace, username };
  };

  const aliceLogin = await signIn('alice');
  const bobLogin = await signIn('bob');

  // The slug grammar allows 32 characters and no trailing hyphen (§1.4), which
  // a truncation could produce. Refuse a long name here rather than let the
  // server refuse a mangled slug three calls later.
  const projectSlug = `chaos-${name}-${runId}`;
  if (projectSlug.length > 32) {
    throw new Error(`Scenario name "${name}" makes the slug "${projectSlug}" too long.`);
  }
  await runCliJson<ProjectDocument>(aliceLogin.workspace, [
    'project',
    'create',
    `Chaos ${name}`,
    '--slug',
    projectSlug,
  ]);
  await runCliJson<unknown>(aliceLogin.workspace, ['project', 'init', projectSlug]);
  await runCliJson<unknown>(aliceLogin.workspace, ['agent', 'create', 'backend']);
  await runCliJson<unknown>(aliceLogin.workspace, ['agent', 'use', 'backend']);

  const invite = await runCliJson<InviteDocument>(aliceLogin.workspace, ['project', 'invite']);
  await runCliJson<unknown>(bobLogin.workspace, ['project', 'join', invite.code, '--yes']);
  await runCliJson<unknown>(bobLogin.workspace, ['project', 'init', projectSlug]);
  await runCliJson<unknown>(bobLogin.workspace, ['agent', 'create', 'reviewer']);
  await runCliJson<unknown>(bobLogin.workspace, ['agent', 'use', 'reviewer']);

  const alice: ChaosActor = {
    workspace: aliceLogin.workspace,
    username: aliceLogin.username,
    address: `@${aliceLogin.username}/backend`,
  };
  const bob: ChaosActor = {
    workspace: bobLogin.workspace,
    username: bobLogin.username,
    address: `@${bobLogin.username}/reviewer`,
  };

  const inbox = (): Promise<InboxDocument> => runCliJson<InboxDocument>(bob.workspace, ['inbox']);

  const scenario: ChaosScenario = {
    clientRelay,
    databaseRelay,
    server: () => server,
    alice,
    bob,

    async restartServer(options = {}): Promise<void> {
      await server.stop(options.signal ?? 'SIGKILL');
      // Whatever was mid-flight through the relay is now talking to a socket
      // whose far end is gone. Reset it rather than leave it half-open, so a
      // client sees the failure now instead of on its next read timeout.
      clientRelay.cut();
      server = await startServerProcess({
        identityOrigin: identityProvider.origin,
        databaseUrl: throughRelay(databaseUrl, databaseRelay),
        ...(options.clockShiftMs === undefined ? {} : { clockShiftMs: options.clockShiftMs }),
      });
      clientRelay.retarget(server.port);
    },

    async rotateServer(options = {}): Promise<void> {
      const outgoing = server;
      const incoming = await startServerProcess({
        identityOrigin: identityProvider.origin,
        databaseUrl: throughRelay(databaseUrl, databaseRelay),
        ...(options.clockShiftMs === undefined ? {} : { clockShiftMs: options.clockShiftMs }),
      });

      // Pointed at the replacement first, so the reconnect that the next line
      // provokes has somewhere to land. Between these two statements the old
      // server is still serving its open connections and the new one is already
      // accepting; there is no instant at which the relay's target is dead.
      server = incoming;
      clientRelay.retarget(incoming.port);
      clientRelay.cut();

      // SIGTERM, not SIGKILL: this models a deploy, and a deploy runs the
      // shutdown path. Nothing is owed to the old process by now — its sockets
      // were cut above and its clients are already dialling the new one.
      await outgoing.stop('SIGTERM');
    },

    listen(actor: ChaosActor, argv: readonly string[] = []): Listener {
      const listener = startListener(actor.workspace, ['--runtime', RUNTIME, ...argv]);
      openListeners.push(listener);
      return listener;
    },

    async listenConnected(actor: ChaosActor, argv: readonly string[] = []): Promise<Listener> {
      const listener = scenario.listen(actor, argv);
      await waitUntilConnected(listener);
      return listener;
    },

    async stopListeners(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
      const listeners = openListeners.splice(0, openListeners.length);
      await Promise.all(listeners.map((listener) => listener.stop(signal)));
    },

    send(content: string, options: readonly string[] = []): Promise<SendDocument> {
      return runCliJson<SendDocument>(alice.workspace, ['send', bob.address, content, ...options]);
    },

    inbox,

    async isPending(messageId: string): Promise<boolean> {
      const pending = await inbox();
      return pending.items.some((item) => item.messageId === messageId);
    },

    async waitUntilAcknowledged(messageId: string): Promise<void> {
      await waitFor(
        `${messageId} to leave the pending inbox`,
        async () => ((await scenario.isPending(messageId)) ? undefined : true),
        { timeoutMs: SETTLE_TIMEOUT_MS, diagnose: () => server.problems() },
      );
    },

    ack(messageId: string): Promise<AckDocument> {
      return runCliJson<AckDocument>(bob.workspace, ['ack', messageId]);
    },

    async waitForSessions(count: number): Promise<void> {
      await waitFor(
        `the roster to report ${String(count)} session(s) for ${bob.address}`,
        async () => {
          const roster = await runCliJson<AgentsDocument>(alice.workspace, ['agents']);
          const entry = roster.items.find((item) => item.address === bob.address);
          return entry !== undefined && entry.sessions === count ? true : undefined;
        },
        { timeoutMs: SETTLE_TIMEOUT_MS },
      );
    },

    async close(): Promise<void> {
      await scenario.stopListeners('SIGKILL');
      await server.stop('SIGTERM');
      await clientRelay.close();
      await databaseRelay.close();
      await identityProvider.close();
      await Promise.all([alice.workspace, bob.workspace].map(removeWorkspace));
    },
  };

  return scenario;
}

export type { ChaosServer, FakeIdentityProvider, Listener, TcpProxy };
