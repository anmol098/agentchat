/**
 * The milestone, proved end to end: two people, two agents, one project, and a
 * message that actually arrives.
 *
 * Read `./harness.ts` first. The short version is that everything here is the
 * software this project ships — the built server as its own process against a
 * real PostgreSQL, the built `agentchat` binary as its own process, real HTTP
 * and a real WebSocket — with one documented exception, the identity provider,
 * which no test can approve a browser flow against.
 *
 * ## What each test is for
 *
 * The six blocks below are the six acceptance criteria of T-314, and each one
 * is written to fail for exactly one reason:
 *
 * 1. **The path exists at all.** Sign in twice, create a project, join it,
 *    create an agent each, and send. This is the test that would have caught
 *    T-043: `send` calls `GET /me`, and against the real server that route did
 *    not exist while every stub in the repository answered it.
 * 2. **A backgrounded listener receives, and the debt is settled.** The
 *    acknowledgement is the half that is easy to lose, so it is asserted
 *    positively — the message is *acknowledged*, not merely absent.
 * 3. **The stdout contract**, over a real socket rather than a stub connector.
 * 4. **Fan-out.** Two sessions for one agent, one message, both receive it.
 * 5. **Offline delivery.** Sent to nobody, delivered on the next hello.
 * 6. **Replay after a crash.** SIGKILL before the acknowledgement, restart, and
 *    the message arrives again — once.
 *
 * ## Why the crash test is last
 *
 * It is the only test that ends a listener without letting it end its session,
 * which is what a crash means. An agent is "online" when it has an `active`
 * session row (Plan §2), and a killed listener leaves one behind until the
 * sweeper notices — so after this test the recipient is reported as online with
 * nothing behind the address. That is correct behaviour and it is exactly the
 * premise the offline-delivery test needs to be false, so the crash goes after
 * it rather than before. Everywhere else, `afterEach` stops listeners with
 * SIGTERM and the sessions end properly.
 *
 * ## Why a message id is threaded through every assertion
 *
 * These tests share one server, one database and one pair of agents, and they
 * run in file order rather than in isolation. So nothing asserts on a *count*
 * of pending messages or on an inbox being empty: every wait and every
 * assertion names the message identifier it is about. A test that asserted "the
 * inbox is empty" would pass or fail depending on what ran before it, which is
 * the kind of failure that gets re-run rather than read.
 */

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  applyMigrations,
  type CliWorkspace,
  createWorkspace,
  type Listener,
  type RunningServer,
  removeWorkspace,
  runCli,
  runCliJson,
  startListener,
  startServer,
  waitFor,
  waitUntilConnected,
} from './harness.js';
import { type FakeIdentityProvider, startIdentityProvider } from './identity-provider.js';

/** Long enough for two logins, a project, two agents and a join. */
const SETUP_TIMEOUT_MS = 120_000;

/** Long enough for a spawn, a WebSocket handshake, a send and a reply. */
const TEST_TIMEOUT_MS = 60_000;

/** How long to wait for something that is expected to have happened by now. */
const SETTLE_TIMEOUT_MS = 20_000;

/**
 * How long to keep watching after a message has been acknowledged, to see
 * whether it arrives a second time.
 *
 * Only used where the *absence* of an event is the claim, which is the one
 * thing a condition cannot be waited for. It is short because it is bounded on
 * the other side: by then the acknowledgement has already round-tripped to the
 * server, so a duplicate replay would have had every chance to happen.
 */
const DUPLICATE_WATCH_MS = 1_500;

/** The runtime name these listeners register under. */
const RUNTIME = 'e2e-harness';

/** A signed-in person with an agent in the project. */
interface Actor {
  /** Their configuration home and working directory. */
  readonly workspace: CliWorkspace;
  /** Their AgentChat username, which is the provider login lowercased. */
  readonly username: string;
  /** Their agent's name within the project. */
  readonly agentName: string;
  /** The address other agents send to, e.g. `@e2e-alice-1a2b/backend`. */
  readonly address: string;
}

/** Shapes of the `--json` documents this suite reads. Only the read fields. */
interface ProjectDocument {
  readonly project: { readonly id: string; readonly slug: string };
}
interface InviteDocument {
  readonly code: string;
}
interface SendDocument {
  readonly messageId: string;
  readonly conversationId: string;
  readonly duplicate: boolean;
  readonly sender: { readonly address: string };
  readonly recipient: { readonly address: string };
}
interface InboxDocument {
  readonly agent: { readonly address: string };
  readonly items: readonly {
    readonly messageId: string;
    readonly sender: string | null;
    readonly recipient: string | null;
    readonly parentMessageId: string | null;
    readonly content: string;
  }[];
}
interface AckDocument {
  readonly items: readonly {
    readonly messageId: string;
    readonly acknowledged: boolean;
    readonly alreadyAcknowledged: boolean;
    readonly acknowledgedAt: string | null;
  }[];
}
interface AgentsDocument {
  readonly items: readonly {
    readonly address: string;
    readonly online: boolean;
    readonly sessions: number;
  }[];
}
interface WhoamiDocument {
  readonly user: { readonly username: string };
}

/** A short lowercase suffix, so a re-run does not collide with the last one. */
const RUN_ID = randomBytes(4).toString('hex');

let identityProvider: FakeIdentityProvider;
let server: RunningServer;
let alice: Actor;
let bob: Actor;
let projectSlug: string;

/** Listeners started by the test currently running, stopped in `afterEach`. */
const openListeners: Listener[] = [];

/** Starts a listener and registers it for teardown even if the test throws. */
function listenAs(actor: Actor, argv: readonly string[] = []): Listener {
  const listener = startListener(actor.workspace, ['--runtime', RUNTIME, ...argv]);
  openListeners.push(listener);
  return listener;
}

/**
 * Signs a new person in through the real device flow.
 *
 * The only fake in the chain is the provider at the far end of it: the CLI runs
 * the whole RFC 8628 client — start, announce, wait an interval, poll — and the
 * server runs the whole of its half, including writing the account row and
 * issuing the token pair the rest of this file authenticates with.
 *
 * @param handle - Short name used for the temporary directory and the username.
 * @returns The workspace and the username the server settled on.
 */
async function signIn(handle: string): Promise<{ workspace: CliWorkspace; username: string }> {
  const username = `e2e-${handle}-${RUN_ID}`;
  const workspace = await createWorkspace(handle);

  identityProvider.enqueue({
    // Unique per run, because `users.github_id` is unique and a second run
    // against the same database must create a second person, not collide.
    id: `e2e-${handle}-${RUN_ID}`,
    login: username,
    name: `${handle} (end to end)`,
    email: `${handle}@example.invalid`,
  });

  const login = await runCli(workspace, ['--json', 'login', '--server', server.baseUrl]);
  expect(
    login.code,
    `login failed for ${handle}.\nstdout: ${login.stdout}\nstderr: ${login.stderr}\nserver problems:\n${server.problems()}`,
  ).toBe(0);

  return { workspace, username };
}

beforeAll(async () => {
  await applyMigrations();
  identityProvider = await startIdentityProvider();
  server = await startServer(identityProvider.origin);

  const aliceLogin = await signIn('alice');
  const bobLogin = await signIn('bob');

  // Alice owns the project and links her working directory to it, which is what
  // makes every later command in that directory resolve a project without being
  // told one.
  projectSlug = `e2e-${RUN_ID}`;
  const created = await runCliJson<ProjectDocument>(aliceLogin.workspace, [
    'project',
    'create',
    'End to end',
    '--slug',
    projectSlug,
  ]);
  expect(created.project.slug).toBe(projectSlug);

  await runCliJson<unknown>(aliceLogin.workspace, ['project', 'init', projectSlug]);
  await runCliJson<unknown>(aliceLogin.workspace, ['agent', 'create', 'backend']);
  await runCliJson<unknown>(aliceLogin.workspace, ['agent', 'use', 'backend']);

  // Bob joins through a real invite code rather than being inserted into the
  // membership table, because the invite is how a second person actually gets
  // into a project.
  const invite = await runCliJson<InviteDocument>(aliceLogin.workspace, ['project', 'invite']);
  await runCliJson<unknown>(bobLogin.workspace, ['project', 'join', invite.code, '--yes']);
  await runCliJson<unknown>(bobLogin.workspace, ['project', 'init', projectSlug]);
  await runCliJson<unknown>(bobLogin.workspace, ['agent', 'create', 'reviewer']);
  await runCliJson<unknown>(bobLogin.workspace, ['agent', 'use', 'reviewer']);

  alice = {
    workspace: aliceLogin.workspace,
    username: aliceLogin.username,
    agentName: 'backend',
    address: `@${aliceLogin.username}/backend`,
  };
  bob = {
    workspace: bobLogin.workspace,
    username: bobLogin.username,
    agentName: 'reviewer',
    address: `@${bobLogin.username}/reviewer`,
  };
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  // SIGTERM, not SIGKILL. A terminated `listen` ends its session on the way
  // out; a killed one leaves an `active` session row behind until the sweeper
  // notices, and "online" is defined as having one of those. So killing here
  // would leave the recipient reported as online with nothing behind the
  // address, and the offline-delivery test could not state its premise.
  //
  // A crash is a thing this suite tests on purpose, once, in the test that
  // needs it — and that test is deliberately last for this reason.
  const listeners = openListeners.splice(0, openListeners.length);
  await Promise.all(listeners.map((listener) => listener.stop('SIGTERM')));
}, SETTLE_TIMEOUT_MS);

afterAll(async () => {
  await server?.stop();
  await identityProvider?.close();
  await Promise.all(
    [alice?.workspace, bob?.workspace]
      .filter((workspace): workspace is CliWorkspace => workspace !== undefined)
      .map(removeWorkspace),
  );
}, SETTLE_TIMEOUT_MS);

/** Sends one message from Alice to Bob and returns what the server said. */
function send(content: string, options: readonly string[] = []): Promise<SendDocument> {
  return runCliJson<SendDocument>(alice.workspace, ['send', bob.address, content, ...options]);
}

/** Bob's pending inbox, as the CLI reports it. */
function bobsInbox(): Promise<InboxDocument> {
  return runCliJson<InboxDocument>(bob.workspace, ['inbox']);
}

/**
 * Waits until a message is no longer owed to Bob.
 *
 * Named by identifier rather than by count, so a message another test left
 * behind cannot make this pass or fail.
 */
async function waitUntilAcknowledged(messageId: string): Promise<void> {
  await waitFor(
    `${messageId} to leave the pending inbox`,
    async () => {
      const inbox = await bobsInbox();
      return inbox.items.some((item) => item.messageId === messageId) ? undefined : true;
    },
    { timeoutMs: SETTLE_TIMEOUT_MS },
  );
}

/**
 * Asserts the inbox row reached the acknowledged state, not merely that the
 * pending listing stopped showing it.
 *
 * Acknowledging again is a success by contract, and the answer carries
 * `alreadyAcknowledged` and the timestamp of the *first* acknowledgement — so
 * this reads the state rather than inferring it from an absence.
 */
async function expectAcknowledged(messageId: string): Promise<void> {
  const acknowledgement = await runCliJson<AckDocument>(bob.workspace, ['ack', messageId]);
  const item = acknowledgement.items.find((entry) => entry.messageId === messageId);

  expect(item, `no acknowledgement result for ${messageId}`).toBeDefined();
  expect(item?.acknowledged).toBe(true);
  expect(item?.alreadyAcknowledged).toBe(true);
  expect(item?.acknowledgedAt).toEqual(expect.any(String));
}

describe('end-to-end delivery', () => {
  it(
    'creates two users with agents in one project and sends a message between them',
    async () => {
      // Two distinct accounts, each answering for itself. `whoami` is one of the
      // five commands T-043 names, and it is the cheapest of them to check.
      const aliceIdentity = await runCliJson<WhoamiDocument>(alice.workspace, ['whoami']);
      const bobIdentity = await runCliJson<WhoamiDocument>(bob.workspace, ['whoami']);
      expect(aliceIdentity.user.username).toBe(alice.username);
      expect(bobIdentity.user.username).toBe(bob.username);
      expect(aliceIdentity.user.username).not.toBe(bobIdentity.user.username);

      // One project, holding both agents. This is project-wide discovery, so it
      // proves the membership Bob obtained through the invite is real.
      const roster = await runCliJson<AgentsDocument>(alice.workspace, ['agents']);
      const addresses = roster.items.map((entry) => entry.address);
      expect(addresses).toContain(alice.address);
      expect(addresses).toContain(bob.address);

      const sent = await send('The first message that ever crossed this suite.');
      expect(sent.messageId).toMatch(/^msg_/);
      expect(sent.conversationId).toMatch(/^cnv_/);
      expect(sent.duplicate).toBe(false);
      expect(sent.sender.address).toBe(alice.address);
      expect(sent.recipient.address).toBe(bob.address);

      // The recipient, and only the recipient, is owed it.
      const inbox = await bobsInbox();
      expect(inbox.agent.address).toBe(bob.address);
      const owed = inbox.items.find((item) => item.messageId === sent.messageId);
      expect(owed, `${sent.messageId} is not in Bob's inbox`).toBeDefined();
      expect(owed?.sender).toBe(alice.address);
      expect(owed?.content).toBe('The first message that ever crossed this suite.');

      // The other half of the asymmetry noted in the listener test below: a
      // listed message names both ends and its parent, and a streamed one does
      // not, though docs/cli.md says the two shapes match field for field.
      expect(owed?.recipient).toBe(bob.address);
      expect(owed?.parentMessageId).toBeNull();

      const senders = await runCliJson<InboxDocument>(alice.workspace, ['inbox']);
      expect(senders.items.map((item) => item.messageId)).not.toContain(sent.messageId);

      await runCliJson<AckDocument>(bob.workspace, ['ack', sent.messageId]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers to a backgrounded listener and moves the inbox to acknowledged',
    async () => {
      const listener = listenAs(bob);

      const listening = await listener.waitForEvent(
        'the listening event',
        (event) => event['event'] === 'listening',
      );
      expect(listening['sessionId']).toEqual(expect.stringMatching(/^ses_/));
      expect(listening['ack']).toBe(true);

      // The socket must be up *before* the send, or this would silently become
      // the offline-delivery test below.
      await waitUntilConnected(listener);

      const sent = await send('Delivered to a process that was already listening.');
      const received = await listener.waitForMessage(sent.messageId);

      expect(received['event']).toBe('message');
      expect(received['messageId']).toBe(sent.messageId);
      expect(received['conversationId']).toBe(sent.conversationId);
      expect(received['projectId']).toEqual(expect.stringMatching(/^prj_/));
      expect(received['sender']).toBe(alice.address);
      expect(received['senderAgentId']).toEqual(expect.stringMatching(/^agt_/));
      expect(received['recipientAgentId']).toEqual(expect.stringMatching(/^agt_/));
      expect(received['createdAt']).toEqual(expect.any(String));
      expect(received['content']).toBe('Delivered to a process that was already listening.');

      // Asserted as it is, not as it is documented. docs/cli.md says the
      // streamed `message` event is the same shape as an `inbox` item "field
      // for field", and it is not: the stream carries `recipientAgentId` and no
      // `recipient`, and no `parentMessageId`, while an inbox item carries
      // both. The next test pins the inbox half so the asymmetry is recorded by
      // a test rather than by a comment. Which of the two is wrong is not
      // T-314's to decide — the streamed frame is built in
      // `server/src/routing/delivery.ts` and the listing in
      // `server/src/routes/messages.ts` — but a harness written from the
      // reference would break on it, so it must not stay invisible.
      expect(received['recipient']).toBeUndefined();

      // The listener acknowledges only once the bytes have reached stdout, so
      // this is the assertion that the whole ordering worked.
      await waitUntilAcknowledged(sent.messageId);
      await expectAcknowledged(sent.messageId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'writes message payloads to stdout and every operational line to stderr',
    async () => {
      const listener = listenAs(bob);
      await waitUntilConnected(listener);

      const sent = await send('Stream separation, over a real socket.');
      await listener.waitForMessage(sent.messageId);

      // Every line on stdout parsed as JSON on the way in; anything that did not
      // is recorded, and there must be none. This is PRD §39 asserted against
      // the real connector rather than the injected one the unit suite uses.
      expect(listener.unparsedStdout()).toEqual([]);
      for (const event of listener.events()) {
        expect(event['event']).toEqual(expect.any(String));
      }

      // And the human's stream is not empty, which is what makes the split a
      // split rather than silence.
      expect(listener.stderr().length).toBeGreaterThan(0);

      await waitUntilAcknowledged(sent.messageId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers one message to both of an agent’s listeners',
    async () => {
      const first = listenAs(bob);
      const second = listenAs(bob);

      // Both sockets up before the send. Waiting on both is what makes this a
      // fan-out test: if the second connected afterwards it would receive the
      // message through replay, which is a different guarantee and is tested
      // separately below.
      await Promise.all([waitUntilConnected(first), waitUntilConnected(second)]);

      // The server agrees there are two of them, which is the same fact seen
      // from the other end.
      const roster = await waitFor(
        'the roster to show two sessions for the recipient',
        async () => {
          const listing = await runCliJson<AgentsDocument>(alice.workspace, ['agents']);
          const entry = listing.items.find((item) => item.address === bob.address);
          return entry !== undefined && entry.sessions >= 2 ? entry : undefined;
        },
        { timeoutMs: SETTLE_TIMEOUT_MS },
      );
      expect(roster.online).toBe(true);

      const sent = await send('One message, two listeners.');

      const [toFirst, toSecond] = await Promise.all([
        first.waitForMessage(sent.messageId),
        second.waitForMessage(sent.messageId),
      ]);

      // The same message, not merely two messages: same conversation, same
      // content, same identifier.
      expect(toFirst['conversationId']).toBe(sent.conversationId);
      expect(toSecond['conversationId']).toBe(sent.conversationId);
      expect(toFirst['content']).toBe('One message, two listeners.');
      expect(toSecond['content']).toBe('One message, two listeners.');

      // One inbox behind two sessions: either acknowledgement clears the debt
      // for both, which is the agent-scoped inbox of D3.
      await waitUntilAcknowledged(sent.messageId);
      await expectAcknowledged(sent.messageId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers a message sent while nothing was listening once a listener starts',
    async () => {
      // Nothing is listening: `afterEach` killed every listener the previous
      // tests started, and the server agrees before the send is made.
      await waitFor(
        'the recipient to be offline',
        async () => {
          const listing = await runCliJson<AgentsDocument>(alice.workspace, ['agents']);
          const entry = listing.items.find((item) => item.address === bob.address);
          return entry !== undefined && !entry.online && entry.sessions === 0 ? entry : undefined;
        },
        { timeoutMs: SETTLE_TIMEOUT_MS },
      );

      const sent = await send('Sent to nobody, and waiting.');

      // Durable in the meantime, which is the property that makes the send
      // safe: nothing was connected and the message still exists.
      const pending = await bobsInbox();
      expect(pending.items.map((item) => item.messageId)).toContain(sent.messageId);

      const listener = listenAs(bob);
      const connected = await waitUntilConnected(listener);

      // The ready frame carries what was waiting, so the listener knows there
      // is a backlog before the first message arrives.
      expect(connected['pending']).toEqual(expect.any(Number));

      const received = await listener.waitForMessage(sent.messageId);
      expect(received['content']).toBe('Sent to nobody, and waiting.');

      await waitUntilAcknowledged(sent.messageId);
      await expectAcknowledged(sent.messageId);
    },
    TEST_TIMEOUT_MS,
  );
  it(
    'replays a message to a restarted listener exactly once when the first died unacknowledged',
    async () => {
      // `--no-ack` is how a listener is made to receive without settling the
      // debt. Killing one mid-acknowledgement would test the same property with
      // a race in it, and a race is what this suite must not have.
      const doomed = listenAs(bob, ['--no-ack']);
      await waitUntilConnected(doomed);

      const sent = await send('Owed to an agent whose listener is about to die.');
      await doomed.waitForMessage(sent.messageId);

      // SIGKILL, so no shutdown path runs: no session end, no closing
      // handshake, nothing. This is a crash, not a stop.
      await doomed.stop('SIGKILL');
      expect(doomed.hasExited()).toBe(true);

      // Still owed. If this fails, the acknowledgement happened without the
      // consumer having done anything with the message.
      const pending = await bobsInbox();
      expect(pending.items.map((item) => item.messageId)).toContain(sent.messageId);

      // A fresh process, which is the case the deduplication has to survive:
      // the replay arrives on `hello`, and the client suppresses a second copy.
      const restarted = listenAs(bob);
      const replayed = await restarted.waitForMessage(sent.messageId);
      expect(replayed['content']).toBe('Owed to an agent whose listener is about to die.');

      await waitUntilAcknowledged(sent.messageId);
      await expectAcknowledged(sent.messageId);

      // Exactly once. The acknowledgement has already round-tripped by now, so
      // any duplicate replay has had its chance; this window is what turns "we
      // have not seen a second copy yet" into "there was not one".
      await new Promise((resolve) => setTimeout(resolve, DUPLICATE_WATCH_MS));
      const copies = restarted.messages().filter((event) => event['messageId'] === sent.messageId);
      expect(
        copies.length,
        `expected one copy of ${sent.messageId}, saw ${String(copies.length)}`,
      ).toBe(1);
    },
    TEST_TIMEOUT_MS,
  );
});
