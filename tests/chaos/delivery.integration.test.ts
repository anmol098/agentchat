/**
 * The promise, attacked: a message survives the recipient being offline, and
 * arrives exactly once as far as the recipient can tell.
 *
 * Delivery is at-least-once (§10.1) and the client deduplicates by `messageId`
 * (§10.2). `../e2e/delivery.integration.test.ts` proves that works when
 * everything works. This file is where it is made to stop working:
 *
 * 1. **The frame is written to a socket nobody will ever read**, and then the
 *    socket is destroyed with a reset — no FIN, no WebSocket close frame,
 *    nothing the server could interpret as a goodbye. The message must come
 *    back on the next `hello`.
 * 2. **The server is killed between committing the message and delivering it.**
 *    Commit-before-delivery is structural in this codebase — `MessageService`
 *    takes no registry and no router, so there is no way to deliver from inside
 *    a send — but "structural" is a claim about the code, and this is the
 *    claim tested against a `SIGKILL`.
 * 3. **The database goes away mid-operation and comes back.** The server must
 *    refuse cleanly while it is gone, stay up, and recover without a restart.
 * 4. **Acknowledgements arrive twice and out of order.** Both are ordinary
 *    under at-least-once, so both must be uneventful.
 * 5. **Two listeners answer for one agent.** D3 makes the inbox agent-scoped:
 *    either session's acknowledgement clears the debt for both, and the second
 *    acknowledgement of the same message is ignored rather than punished.
 *
 * ## Why `--no-ack` does the work
 *
 * Several tests need a listener that receives a message without settling it.
 * `--no-ack` is that, and it is used rather than racing a `SIGKILL` against an
 * acknowledgement in flight: a race is precisely what a chaos suite must not
 * contain, because a chaos test that fails one run in twenty teaches everyone
 * to re-run red builds.
 *
 * The cost is that these tests leave messages pending for the life of the
 * database. That is why nothing here asserts on a count or on an empty inbox —
 * every assertion names its own message identifier.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { Listener } from '../e2e/harness.js';
import { runCli, waitFor } from './harness.js';
import { type ChaosScenario, createScenario, SETTLE_TIMEOUT_MS } from './scenario.js';

/** Long enough for two device flows, a project, two agents and a join. */
const SETUP_TIMEOUT_MS = 180_000;

/** Long enough for a kill, a restart, a reconnect and a replay. */
const TEST_TIMEOUT_MS = 90_000;

/**
 * How long to keep watching after the thing that should have happened has, to
 * see whether something that must not happen does.
 *
 * Only used where the *absence* of an event is the claim. Every such assertion
 * here is bounded on the other side by an event that must arrive — a control
 * message, or an acknowledgement that has already round-tripped — so the window
 * is a margin rather than the assertion itself.
 */
const QUIET_WATCH_MS = 1_500;

let chaos: ChaosScenario;

beforeAll(async () => {
  chaos = await createScenario('delivery');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  // Whatever a test broke, the next one starts with the wires intact — and the
  // wires are mended *before* the listeners are stopped, because a terminated
  // `listen` ends its session on the way out and a severed connection would
  // make it wait to be killed instead.
  chaos.clientRelay.refuse(false);
  chaos.clientRelay.resume();
  chaos.databaseRelay.refuse(false);
  chaos.databaseRelay.resume();
  await chaos.stopListeners('SIGTERM');
}, SETTLE_TIMEOUT_MS);

afterAll(async () => {
  await chaos?.close();
}, SETTLE_TIMEOUT_MS);

/** The `message` events a listener has emitted carrying one identifier. */
function copiesOf(listener: Listener, messageId: string): readonly unknown[] {
  return listener.messages().filter((event) => event['messageId'] === messageId);
}

/**
 * What the server says a fan-out did.
 *
 * `DeliveryService.deliver` logs at `info` when a message reached no live
 * socket, and says nothing when it reached one. That asymmetry is what lets a
 * test tell the two apart, and the distinction is the whole point of the tests
 * below: a message that was never written to a socket would prove nothing about
 * a socket dying under a message that was.
 *
 * @param messageId - The message to ask about.
 * @returns Whether the fan-out found at least one socket to write to.
 */
function reachedALiveSocket(messageId: string): boolean {
  return !chaos
    .server()
    .records()
    .some(
      (record) =>
        record['msg'] === 'message delivered to no live socket; it stays pending' &&
        record['messageId'] === messageId,
    );
}

describe('a message survives the connection failing under it', () => {
  it(
    'replays a message whose delivery frame died on a socket that was never read',
    async () => {
      const listener = await chaos.listenConnected(chaos.bob, ['--no-ack']);

      // From here the listener's connection carries bytes no further. It is not
      // closed and the server has no way to know: this is a peer that has
      // stopped reading, which is the state §9.8 is written about.
      expect(chaos.clientRelay.stall()).toBeGreaterThan(0);

      // `send` dials its own connection, which is not stalled, and the route
      // fans out before it answers — so by the time this resolves the frame has
      // been written into the socket that goes nowhere.
      const sent = await chaos.send('Written to a socket that will never be read.');
      expect(
        reachedALiveSocket(sent.messageId),
        'the fan-out found no socket, so this is the offline case rather than the stalled one',
      ).toBe(true);
      expect(copiesOf(listener, sent.messageId)).toHaveLength(0);

      // A reset, not a close. The server sees the connection vanish rather than
      // end, so nothing about the disappearance is orderly enough to be a hint.
      expect(chaos.clientRelay.cut()).toBeGreaterThan(0);

      // The debt is unchanged: a delivery attempt reduces nothing (§10.1).
      expect(await chaos.isPending(sent.messageId)).toBe(true);

      // The listener reconnects on its own, says `hello` on the same session,
      // and is replayed what it never read.
      const replayed = await listener.waitForMessage(sent.messageId);
      expect(replayed['content']).toBe('Written to a socket that will never be read.');
      expect(copiesOf(listener, sent.messageId)).toHaveLength(1);

      const acknowledgement = await chaos.ack(sent.messageId);
      expect(acknowledgement.items[0]?.acknowledged).toBe(true);
      expect(acknowledgement.items[0]?.alreadyAcknowledged).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers a message the server committed and was killed before it could deliver',
    async () => {
      const listener = await chaos.listenConnected(chaos.bob, ['--no-ack']);
      chaos.clientRelay.stall();

      const sent = await chaos.send('Committed by a server that did not survive the fan-out.');
      expect(
        reachedALiveSocket(sent.messageId),
        'the fan-out found no socket, so this is the offline case rather than the stalled one',
      ).toBe(true);
      expect(copiesOf(listener, sent.messageId)).toHaveLength(0);

      // SIGKILL: no signal handler, no shutdown ordering, no drained pool, no
      // closed sockets. Everything the process knew that was not in PostgreSQL
      // is gone, including the whole delivery registry.
      await chaos.restartServer({ signal: 'SIGKILL' });

      // The message is still owed, which is the entire claim of §10.1's
      // "committed before any delivery attempt". A message that had been
      // written to a socket and nowhere else would be absent here.
      expect(await chaos.isPending(sent.messageId)).toBe(true);

      const replayed = await listener.waitForMessage(sent.messageId);
      expect(replayed['content']).toBe('Committed by a server that did not survive the fan-out.');

      // And it is still one message, not one per surviving copy of the state.
      expect(copiesOf(listener, sent.messageId)).toHaveLength(1);
      await chaos.ack(sent.messageId);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses cleanly while the database is gone, stays up, and recovers without a restart',
    async () => {
      const before = chaos.server();

      // The connections the pool holds are reset, and new ones are refused. To
      // the server this is indistinguishable from PostgreSQL being restarted
      // under it, which is what a managed database does during maintenance.
      chaos.databaseRelay.refuse(true);
      chaos.databaseRelay.cut();

      const refused = await runCli(chaos.alice.workspace, [
        '--json',
        'send',
        chaos.bob.address,
        'Sent while the database was unreachable.',
      ]);
      expect(
        refused.code,
        `expected a refusal, got exit ${String(refused.code)}\nstdout: ${refused.stdout}`,
      ).not.toBe(0);

      // Refused, not lost: nothing was written, so there is nothing to replay
      // and nothing to explain to the sender later. And the server is still the
      // same process — a database outage must not be able to take it down.
      expect(before.hasExited()).toBe(false);

      chaos.databaseRelay.refuse(false);

      // No restart, no intervention: the pool reconnects on demand. The retry
      // is a wait for a condition rather than a sleep, because how long a pool
      // takes to notice is exactly the kind of number that is different on a
      // loaded machine.
      const sent = await waitFor(
        'the server to start accepting sends again',
        async () => {
          const attempt = await runCli(chaos.alice.workspace, [
            '--json',
            'send',
            chaos.bob.address,
            'Sent once the database came back.',
          ]);
          return attempt.code === 0 ? attempt : undefined;
        },
        { timeoutMs: SETTLE_TIMEOUT_MS, diagnose: () => chaos.server().problems() },
      );

      expect(chaos.server()).toBe(before);

      const receipt = JSON.parse(sent.stdout.split('\n')[0] ?? '{}') as { messageId?: string };
      expect(receipt.messageId).toEqual(expect.stringMatching(/^msg_/));

      const listener = await chaos.listenConnected(chaos.bob);
      const delivered = await listener.waitForMessage(receipt.messageId ?? '');
      expect(delivered['content']).toBe('Sent once the database came back.');
      await chaos.waitUntilAcknowledged(receipt.messageId ?? '');
    },
    TEST_TIMEOUT_MS,
  );
});

describe('acknowledgement is idempotent and unordered', () => {
  it(
    'accepts acknowledgements twice and out of order without losing one',
    async () => {
      // Nothing is listening, so all three simply sit in the inbox and can be
      // settled in whatever order this test likes.
      const first = await chaos.send('First of three.');
      const second = await chaos.send('Second of three.');
      const third = await chaos.send('Third of three.');

      // Newest first. Acknowledgement is a fact about one inbox row and carries
      // no ordering claim, so a client that settles a backlog out of order —
      // which any concurrent consumer does — must not disturb the other rows.
      const thirdResult = await chaos.ack(third.messageId);
      expect(thirdResult.items[0]?.acknowledged).toBe(true);
      expect(thirdResult.items[0]?.alreadyAcknowledged).toBe(false);
      const acknowledgedAt = thirdResult.items[0]?.acknowledgedAt;
      expect(acknowledgedAt).toEqual(expect.any(String));

      expect(await chaos.isPending(first.messageId)).toBe(true);
      expect(await chaos.isPending(second.messageId)).toBe(true);

      // The same message again. §10.2 requires this to be a success carrying
      // `alreadyAcknowledged`, because a client that replays its unsent
      // acknowledgements after a restart is doing the correct thing.
      const repeated = await chaos.ack(third.messageId);
      expect(repeated.items[0]?.acknowledged).toBe(true);
      expect(repeated.items[0]?.alreadyAcknowledged).toBe(true);

      // And the timestamp is the *first* acknowledgement's, not this one's. A
      // second acknowledgement that moved it would be a write where the
      // contract promises a no-op.
      expect(repeated.items[0]?.acknowledgedAt).toBe(acknowledgedAt);

      await chaos.ack(first.messageId);
      await chaos.ack(second.messageId);

      for (const message of [first, second, third]) {
        expect(
          await chaos.isPending(message.messageId),
          `${message.messageId} is still owed after being acknowledged`,
        ).toBe(false);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('two listeners answer for one agent', () => {
  it(
    'clears the debt for every session of the agent, and ignores the second acknowledgement',
    async () => {
      const [first, second] = await Promise.all([
        chaos.listenConnected(chaos.bob),
        chaos.listenConnected(chaos.bob),
      ]);
      await chaos.waitForSessions(2);

      const sent = await chaos.send('One message, two sessions, one debt.');

      // Both receive it, and both acknowledge it, because both are ordinary
      // listeners. One acknowledgement clears the row; the other arrives at a
      // row that owes nothing.
      await Promise.all([
        first.waitForMessage(sent.messageId),
        second.waitForMessage(sent.messageId),
      ]);
      await chaos.waitUntilAcknowledged(sent.messageId);

      // §9.3: an acknowledgement that clears nothing is ignored, not refused.
      // If it closed the socket, the loser of that race would reconnect — so
      // the absence of a reconnection is the assertion that it did not.
      const events = [first, second].map((listener) => listener.events().length);
      await new Promise((resolve) => setTimeout(resolve, QUIET_WATCH_MS));

      for (const [index, listener] of [first, second].entries()) {
        expect(listener.hasExited(), 'a listener exited after a duplicate acknowledgement').toBe(
          false,
        );
        const since = listener.events().slice(events[index] ?? 0);
        expect(
          since.filter((event) => event['event'] === 'status' && event['state'] !== 'connected'),
          'a listener was disconnected after a duplicate acknowledgement',
        ).toEqual([]);
      }

      // The debt is cleared for the *agent*, not for the session that settled
      // it (D3). A third listener replays what is owed; this message must not
      // be in that replay, and the control message sent after it must be — so
      // the absence is bounded by an arrival rather than by a timer.
      await chaos.stopListeners('SIGTERM');
      const control = await chaos.send('Sent after the debt was settled.');

      const third = await chaos.listenConnected(chaos.bob);
      await third.waitForMessage(control.messageId);
      expect(
        copiesOf(third, sent.messageId),
        'an acknowledged message was replayed to another session of the same agent',
      ).toHaveLength(0);

      await chaos.waitUntilAcknowledged(control.messageId);
    },
    TEST_TIMEOUT_MS,
  );
});
