/**
 * The bounds, from both sides: the largest message the system accepts, the
 * first one it refuses, and what happens to a listener that stops reading.
 *
 * ## Why these belong in a resilience suite
 *
 * A limit is only a limit if crossing it fails *cleanly*. The interesting
 * failure is not the refusal — it is everything around it:
 *
 * - **At the limit, nothing degrades.** A 1 MiB message (D10) has to survive the
 *   HTTP body limit, the row's `CHECK`, and a WebSocket frame limit that is the
 *   same 2 MiB for the envelope as for the body. If any of those were off by a
 *   little, the failure would be a message that sends and never arrives.
 * - **One byte over, nothing is written.** A refusal that had already committed
 *   would leave a message the sender was told did not exist.
 * - **A listener that stops reading is closed, and loses nothing.** §9.8: past
 *   16 MiB queued and unread the server closes the socket rather than run out
 *   of memory. The frame that trips the ceiling has already been written, so it
 *   is unacknowledged either way, and it must come back on the next `hello`.
 * - **And a stalled consumer is nobody else's problem.** Delivery writes a
 *   frame and returns, so the agent's other session must receive at ordinary
 *   speed while the first one holds a backlog.
 *
 * ## Order matters in this file
 *
 * The ceiling test is last because it is the only one that deliberately leaves
 * megabytes owed to an agent for as long as it takes to replay them, and
 * because it must be the only listener running: a healthy sibling session would
 * acknowledge the flood on the stalled one's behalf (D3) and there would be
 * nothing left to replay.
 *
 * ## The close code is asserted, and that is a change
 *
 * An earlier draft of this file deliberately said nothing about the close code,
 * because T-032 had chosen `1000` and T-048 was still open on whether a peer
 * dropped for not reading should be distinguishable from a server shutting
 * down. T-048 has since landed: the code is `4429`, `BACKLOG_UNREAD`, and it is
 * documented in `docs/protocol.md` §9.8 and in the table in
 * `server/src/websocket/frames.ts`.
 *
 * That makes it worth pinning, because it is now the only thing that tells a
 * client which of the two happened, and the two want opposite responses: a
 * restart is answered by reconnecting unchanged, and a backlog close is
 * answered by reading faster or reconnecting less eagerly. A client that could
 * not tell them apart would reconnect into the same close forever — which,
 * past a certain backlog size, is exactly what the last test in this file shows
 * it does anyway.
 *
 * Asserting it costs one relay `resume()`: while the peer is stalled the close
 * frame cannot reach it, so the test un-stalls the wire after the server has
 * already given up, and reads the code out of the listener's own status events
 * rather than out of a server log. What a client can observe is the thing the
 * code exists for.
 */

import { MAX_MESSAGE_CONTENT_BYTES } from '@agentchat/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { runCliWithInput, waitFor } from './harness.js';
import { type ChaosScenario, createScenario, SETTLE_TIMEOUT_MS } from './scenario.js';

/**
 * What a client is told when the server gives up on it for not reading.
 *
 * `docs/protocol.md` §9.8 and its close-code table, spelled out here rather
 * than imported, because on `main` today there is nothing to import it from.
 * `@agentchat/client`'s `WsCloseCode` — the enumeration a client branches on —
 * stops at `4422` and has no name for this one, so `closeDisposition` reaches
 * it only through its unrecognised-code fallback. That is T-051, and it is
 * already open on its own branch.
 *
 * The literal is therefore deliberate and temporary: it is the number the
 * *document* promises, asserted against what a real listener actually reports,
 * which is the only pairing that can catch the two halves drifting apart. When
 * T-051 lands, this becomes `WsCloseCode.BACKLOG_UNREAD` and the assertion gets
 * stronger for free.
 */
const BACKLOG_UNREAD_CLOSE_CODE = 4429;

/** Long enough for two device flows, a project, two agents and a join. */
const SETUP_TIMEOUT_MS = 180_000;

/** Long enough for a megabyte to cross HTTP, a socket and a pipe. */
const TEST_TIMEOUT_MS = 120_000;

/** Long enough to write, replay and acknowledge tens of megabytes. */
const CEILING_TIMEOUT_MS = 300_000;

/**
 * The most 1 MiB messages the ceiling test will send before giving up.
 *
 * The bound is 16 MiB of *unread socket buffer*, and the kernel absorbs some
 * megabytes of that on both sides before the server's own buffer starts to
 * grow, so the number of messages needed is a property of the machine rather
 * than of the server. The loop therefore stops on the server saying it closed
 * the socket, and this is only the point at which a run that is never going to
 * trip the bound admits it — twice the ceiling is far past any plausible amount
 * of kernel buffering, so reaching it means the ceiling is not working.
 */
const CEILING_ATTEMPT_LIMIT = 32;

/** What the server logs when it closes a socket for not being read (§9.8). */
const UNREAD_CLOSE_LOG =
  'websocket peer is not reading; closing it before its backlog exhausts the process';

/** The shape of a `--json` failure envelope. Only the fields read here. */
interface ErrorEnvelope {
  readonly error?: { readonly code?: string; readonly message?: string };
}

/**
 * How long the defect test below waits before concluding the replay is stuck.
 *
 * It is expected to fail, so this is a cost every run pays. Short, therefore —
 * but long enough for several reconnect attempts, so that what it reports is a
 * listener that keeps being closed rather than one that had not started yet.
 */
const DEFECT_WATCH_MS = 45_000;

let chaos: ChaosScenario;

/** The messages the ceiling test left owed, oldest first. Its last one tripped it. */
let backlog: readonly string[] = [];

beforeAll(async () => {
  chaos = await createScenario('limits');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  // The wires are put back *before* the listeners are stopped. A terminated
  // `listen` ends its session on the way out, and a stalled connection would
  // make it wait ten seconds to be killed instead.
  chaos.clientRelay.refuse(false);
  chaos.clientRelay.resume();
  await chaos.stopListeners('SIGTERM');
}, SETTLE_TIMEOUT_MS);

afterAll(async () => {
  await chaos?.close();
}, SETTLE_TIMEOUT_MS);

/**
 * Sends a body through standard input.
 *
 * `agentchat send <address> -` is the only way a body this size can be passed:
 * a megabyte in one `argv` entry is over Linux's 128 KiB per-argument limit and
 * `execve` refuses the process outright.
 *
 * @param body - The message content, verbatim. Nothing is trimmed.
 * @returns The finished run, whatever its exit code.
 */
function sendBody(body: string) {
  return runCliWithInput(chaos.alice.workspace, ['--json', 'send', chaos.bob.address, '-'], body);
}

/** The first JSON document a run wrote to stdout. */
function documentOf(stdout: string): unknown {
  const first = stdout.split('\n').find((line) => line.trim() !== '');
  return first === undefined ? undefined : JSON.parse(first);
}

describe('the message size limit', () => {
  it(
    'accepts a message of exactly the limit and delivers it whole',
    async () => {
      const listener = await chaos.listenConnected(chaos.bob);

      // ASCII, so one character is one byte and the boundary is the one D10
      // names. The last byte is distinct so a truncation somewhere in the chain
      // is a failed assertion rather than a message that merely looks right.
      const body = `${'a'.repeat(MAX_MESSAGE_CONTENT_BYTES - 1)}z`;
      expect(Buffer.byteLength(body, 'utf8')).toBe(MAX_MESSAGE_CONTENT_BYTES);

      const run = await sendBody(body);
      expect(run.code, `send failed.\nstdout: ${run.stdout.slice(0, 500)}`).toBe(0);

      const receipt = documentOf(run.stdout) as { messageId?: string };
      expect(receipt.messageId).toEqual(expect.stringMatching(/^msg_/));

      // The whole way through: committed, then across a WebSocket whose frame
      // limit is the same 2 MiB that has to hold this body *and* its envelope,
      // then out of the listener's stdout as one line of JSON.
      const delivered = await listener.waitForMessage(receipt.messageId ?? '');
      expect(delivered['content']).toBe(body);

      await chaos.waitUntilAcknowledged(receipt.messageId ?? '');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses one byte over the limit, cleanly, before anything is written',
    async () => {
      const over = `${'a'.repeat(MAX_MESSAGE_CONTENT_BYTES)}z`;
      expect(Buffer.byteLength(over, 'utf8')).toBe(MAX_MESSAGE_CONTENT_BYTES + 1);

      const refused = await sendBody(over);

      // Clean means three things at once: a failure exit code, a structured
      // reason on stdout that a `--json` consumer can branch on without reading
      // prose, and nothing on stdout that could be mistaken for a receipt.
      expect(refused.code).toBe(1);
      const envelope = documentOf(refused.stdout) as ErrorEnvelope;
      expect(envelope.error?.code).toBe('PAYLOAD_TOO_LARGE');
      expect(envelope.error?.message).toEqual(expect.stringContaining('1,048,576'));
      expect(refused.stdout).not.toContain('"messageId"');

      // And the refusal cost the recipient nothing. A message that had been
      // committed and then refused would be a message the sender was told does
      // not exist, sitting in somebody's inbox — so the proof is that the very
      // next send is the next thing the recipient is owed.
      const after = await chaos.send('Sent immediately after a refused message.');
      const inbox = await chaos.inbox();
      const owed = inbox.items.find((item) => item.messageId === after.messageId);
      expect(owed?.content).toBe('Sent immediately after a refused message.');
      expect(
        inbox.items.some((item) => item.content.length > MAX_MESSAGE_CONTENT_BYTES),
        'an over-limit message reached the inbox',
      ).toBe(false);

      await chaos.ack(after.messageId);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('a consumer that has stopped reading', () => {
  it(
    'does not delay delivery to the agent’s other session',
    async () => {
      // The stalled one first, then the stall, then the healthy one: `stall`
      // acts on the connections that are open when it is called and never on
      // later ones, which is how one of an agent's two sessions is silenced
      // while the other stays ordinary.
      const stalled = await chaos.listenConnected(chaos.bob, ['--no-ack']);
      expect(chaos.clientRelay.stall()).toBeGreaterThan(0);

      const healthy = await chaos.listenConnected(chaos.bob);
      await chaos.waitForSessions(2);

      const sent = await chaos.send('Delivered past a session that stopped reading.');

      // The whole claim, and the reason delivery writes a frame and returns
      // rather than waiting for it to be read.
      const received = await healthy.waitForMessage(sent.messageId);
      expect(received['content']).toBe('Delivered past a session that stopped reading.');
      await chaos.waitUntilAcknowledged(sent.messageId);

      // The stalled session is still stalled, not closed: one message is far
      // short of the ceiling, so nothing about it has been given up on.
      expect(stalled.hasExited()).toBe(false);
      expect(
        stalled.messages().filter((event) => event['messageId'] === sent.messageId),
      ).toHaveLength(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'is closed once its backlog passes the ceiling',
    async () => {
      const listener = await chaos.listenConnected(chaos.bob);
      await chaos.waitForSessions(1);
      expect(chaos.clientRelay.stall()).toBeGreaterThan(0);

      // A megabyte at a time until the server says it gave up on the socket.
      // The stop condition is the server's own log rather than a byte count,
      // because how much the two kernels absorb before the server's buffer
      // starts to grow is a property of the machine.
      const body = 'a'.repeat(MAX_MESSAGE_CONTENT_BYTES);
      const sent: string[] = [];

      const closed = await waitFor(
        'the server to close the socket of a peer that is not reading',
        async () => {
          const record = chaos
            .server()
            .records()
            .find((entry) => entry['msg'] === UNREAD_CLOSE_LOG);
          if (record !== undefined) {
            return record;
          }
          if (sent.length >= CEILING_ATTEMPT_LIMIT) {
            throw new Error(
              `Sent ${String(sent.length)} messages of ${String(MAX_MESSAGE_CONTENT_BYTES)} ` +
                'bytes to a socket nobody is reading and the server never closed it. That is ' +
                'far past any plausible amount of kernel buffering, so the §9.8 ceiling is ' +
                'not being enforced.',
            );
          }
          const run = await sendBody(body);
          expect(run.code, `send ${String(sent.length)} failed: ${run.stdout.slice(0, 300)}`).toBe(
            0,
          );
          const receipt = documentOf(run.stdout) as { messageId?: string };
          sent.push(receipt.messageId ?? '');
          return undefined;
        },
        {
          timeoutMs: CEILING_TIMEOUT_MS - 30_000,
          diagnose: () =>
            `sent ${String(sent.length)} message(s) of ${String(MAX_MESSAGE_CONTENT_BYTES)} bytes ` +
            `without the server reporting an unread backlog. Attempt limit is ` +
            `${String(CEILING_ATTEMPT_LIMIT)}.`,
        },
      );

      expect(closed['bufferedBytes']).toEqual(expect.any(Number));
      expect(Number(closed['bufferedBytes'])).toBeGreaterThan(Number(closed['limitBytes']));

      // The frame that tripped the ceiling was written before the buffer was
      // measured, so it is unacknowledged whichever way that write went — and
      // §9.8 says that costs nothing, because §10.1 owes it until it is
      // acknowledged. The last message sent is that frame.
      const tripping = sent[sent.length - 1];
      expect(tripping).toEqual(expect.stringMatching(/^msg_/));

      // Nothing was lost by the close, which is the half of §9.8 that follows
      // from §10.1: the frame had already been written, so it was unacknowledged
      // whichever way that write went, and the row still says so.
      expect(await chaos.isPending(tripping ?? '')).toBe(true);

      // Now let the peer read again, so the close frame the server has already
      // written can reach it. Nothing can be settled by this: the server closed
      // the socket before any of it was drained, so the acknowledgements the
      // client sends on the way through go into a socket that is gone.
      chaos.clientRelay.resume();

      const closure = await waitFor(
        'the listener to report the close code the server dropped it with',
        () =>
          listener
            .events()
            .find((event) => event['event'] === 'status' && typeof event['code'] === 'number'),
        {
          timeoutMs: SETTLE_TIMEOUT_MS,
          diagnose: () => listener.stderr().slice(-2_000),
        },
      );

      // T-048's whole point: `4429` and not `1000`. A client that saw a normal
      // closure here would reconnect exactly as it does after a deploy, learn
      // nothing, and be dropped again.
      expect(
        closure['code'],
        'the peer was dropped for not reading but told it was an ordinary close',
      ).toBe(BACKLOG_UNREAD_CLOSE_CODE);

      // And still owed after all that — the drain, the close, and whatever the
      // client tried to acknowledge on its way past.
      expect(await chaos.isPending(tripping ?? '')).toBe(true);

      // Leaves the whole backlog owed, on purpose, for the test below.
      backlog = sent;
      expect(listener.hasExited()).toBe(false);
    },
    CEILING_TIMEOUT_MS,
  );

  /**
   * **A backlog bigger than the ceiling can never be delivered.**
   *
   * This test is marked `fails`, which is Vitest for "the assertions below are
   * what the contract says, and they do not hold". It is not skipped: the body
   * runs on every integration run, and the day the defect is fixed this test
   * starts failing and whoever fixed it removes the marker.
   *
   * ## What happens
   *
   * A fresh `agentchat listen` says `hello`. Replay writes everything the agent
   * is owed to the socket — a page at a time, up to `REPLAY_PAGE_SIZE` (100)
   * messages per page, each written before the next is read. Every write goes
   * through the seam that enforces §9.8, so once more than 16 MiB is queued and
   * unread the socket is closed. The peer *is* reading, but it cannot read a
   * megabyte-per-message page as fast as a loopback socket can be filled.
   *
   * So the handshake never reaches `ready`. The client backs off, reconnects,
   * says `hello`, and is closed again at the same point. The listener's own
   * stdout shows the shape of it: `status connecting`, some `message` events,
   * and never a `status connected`. Nothing is acknowledged, because the
   * acknowledgements the client sends go into a socket the server has already
   * closed, so the backlog does not shrink and the next attempt is identical.
   *
   * The listener is not merely slow. It never recovers.
   *
   * ## Why the two numbers cannot both be right
   *
   * - D10 allows a message of 1 MiB.
   * - `REPLAY_PAGE_SIZE` is 100 messages, written to the socket before the next
   *   page is read (`server/src/routing/delivery.ts`).
   * - `MAX_BUFFERED_BYTES` is 16 MiB (`server/src/websocket/handler.ts`).
   *
   * One page is therefore up to 100 MiB against a 16 MiB ceiling. §9.8 derives
   * its headroom from "a pessimistic page of 64 KiB messages is about 6.5 MiB",
   * which is a page of 64 KiB messages, not a page of the largest message the
   * product accepts. Any agent owed more than ~16 MiB is in this state, and
   * seventeen ordinary 1 MiB patches is enough to get there.
   *
   * ## What it contradicts
   *
   * §9.8: "Nothing is lost… All of it is replayed on the next `hello`", and
   * T-032's own acceptance criterion that closing a stalled socket is safe
   * *because* unacknowledged messages replay. They do not, past this size.
   *
   * The fix is not this task's — it is in `server/src/websocket/handler.ts` and
   * `server/src/routing/delivery.ts`, which T-509 does not own, and it is a
   * design decision (drain before continuing a replay, size the page in bytes
   * rather than rows, or raise the ceiling above a page of maximum-size
   * messages) rather than a patch. It is reported on the board.
   */
  // T-053 fixed this. A replay now waits for the socket to drain before every
  // frame, so a backlog of any legal size reaches `ready` and the ceiling is
  // never approached during a catch-up. This ran as `it.fails` and then as
  // `it.skip` while the defect stood; it is a plain assertion again, and it is
  // the end-to-end proof that the fix holds through the real server and the
  // real CLI rather than only in the unit reproduction.
  it(
    'replays a backlog bigger than the ceiling to a fresh listener',
    async () => {
      expect(backlog.length, 'the test that builds the backlog did not run').toBeGreaterThan(0);
      const tripping = backlog[backlog.length - 1] ?? '';
      expect(await chaos.isPending(tripping)).toBe(true);

      // A fresh `listen`, on a connection nothing is interfering with. §9.8
      // promises this is all it takes: "reconnect and unacknowledged messages
      // replay".
      const listener = chaos.listen(chaos.bob);

      const diagnose = (): string => {
        const closes = chaos
          .server()
          .records()
          .filter((entry) => entry['msg'] === UNREAD_CLOSE_LOG);
        return [
          `backlog: ${String(backlog.length)} message(s) of ${String(MAX_MESSAGE_CONTENT_BYTES)} bytes`,
          `the listener has printed ${String(listener.messages().length)} of them`,
          `the server has closed a socket for not reading ${String(closes.length)} time(s):`,
          closes.map((record) => JSON.stringify(record)).join('\n'),
          'listener stdout events (last 20, contents elided):',
          listener
            .events()
            .slice(-20)
            .map((event) => JSON.stringify({ ...event, content: undefined }))
            .join('\n'),
          'listener stderr:',
          listener.stderr().slice(-3_000),
        ].join('\n');
      };

      // The handshake has to finish before anything else can be claimed: `ready`
      // means "you are caught up" (§9.2), and it is the frame that never comes.
      await waitFor(
        'the fresh listener to finish its handshake and report a connected socket',
        () =>
          listener
            .events()
            .find((event) => event['event'] === 'status' && event['state'] === 'connected'),
        { timeoutMs: DEFECT_WATCH_MS, diagnose },
      );

      const replayed = await waitFor(
        `the message that tripped the ceiling (${tripping}) to be replayed`,
        () => listener.messages().find((event) => event['messageId'] === tripping),
        { timeoutMs: DEFECT_WATCH_MS, diagnose },
      );
      expect(replayed['content']).toBe('a'.repeat(MAX_MESSAGE_CONTENT_BYTES));
    },
    CEILING_TIMEOUT_MS,
  );
});
