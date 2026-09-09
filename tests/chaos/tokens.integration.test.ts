/**
 * The hour that runs out under a listener nobody is watching.
 *
 * `agentchat listen` is meant to be left running. The access token it holds is
 * good for one hour (`ACCESS_TOKEN_TTL_SECONDS` in `server/src/auth/tokens.ts`),
 * and the refresh token behind it for ninety days, so the *ordinary* state of a
 * long-lived listener is one whose credential has expired and been renewed
 * several times over. Nobody is at the keyboard when that happens. If it went
 * wrong, the symptom would be a harness that stopped receiving messages an hour
 * after it started, with a message sitting in an inbox and no error anywhere
 * the operator was looking.
 *
 * ## How an hour is made to pass
 *
 * By moving the server's clock, not by waiting. `./clock-shift.mjs` explains
 * why that substitution is narrow enough to be honest: the session lifecycle
 * and every `created_at` in this schema are written in *database* time
 * (`defaultNow()`, which is `now()`), and the application clock is consulted
 * for one thing — minting and verifying JSON Web Tokens. So the token is
 * genuinely past its `exp`, the server genuinely refuses it, and
 * `@agentchat/client` genuinely spends a refresh token to recover. Only the
 * hour is faked.
 *
 * ## Why the server is rotated rather than restarted
 *
 * {@link ChaosScenario.rotateServer} replaces the process without an outage.
 * That is deliberate, and it is the difference between a test that means
 * something and a test that means two things at once.
 *
 * The reference client allows itself **one** token refresh per streak of
 * failures, and the streak only resets when a connection reaches `ready`
 * (`packages/client/src/websocket/listener.ts`, `#refreshedThisStreak`). A
 * restart leaves a window in which the relay's target is a closed port; a
 * connection that dies there never opens a socket, which is the same shape as
 * an upgrade refused with HTTP 401, so the client spends its one refresh on the
 * outage and has none left for the expiry. Whether that window is hit at all
 * depends on how the backoff falls against how long a Node process takes to
 * bind a port — which is to say, on the machine. A test built on that race
 * would be exactly the flaky chaos test this suite exists not to be.
 *
 * The race is not hypothetical and it is not this file's to fix. It is reported
 * on the task rather than hidden behind a retry here.
 *
 * ## The other half: a skewed clock must not reach the record
 *
 * A fleet always contains one machine whose clock is wrong. The last test here
 * is the assertion that this costs nothing beyond the tokens: a message
 * committed by a server running two hours ahead is still stamped in database
 * time, so ordering, `createdAt`, and every consumer reading it are unaffected
 * by which node happened to accept the send.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { type ChaosScenario, createScenario, SETTLE_TIMEOUT_MS } from './scenario.js';

/** Long enough for two device flows, a project, two agents and a join. */
const SETUP_TIMEOUT_MS = 180_000;

/** Long enough for a rotation, a refused upgrade, a refresh and a reconnect. */
const TEST_TIMEOUT_MS = 120_000;

/**
 * How far to move the replacement server's clock.
 *
 * Twice `ACCESS_TOKEN_TTL_SECONDS` (one hour), so every access token minted
 * before the rotation is past its `exp` by a margin no clock difference between
 * two processes on the same machine could account for — and far short of
 * `REFRESH_TOKEN_TTL_SECONDS` (ninety days), because a test in which the
 * refresh token had also expired would be testing a logout.
 */
const CLOCK_SHIFT_MS = 2 * 60 * 60 * 1_000;

/**
 * How far a database timestamp may sit from this process's clock.
 *
 * Generous, because it is not measuring precision: it only has to be small
 * enough to separate "written in database time" from "written by a process
 * running {@link CLOCK_SHIFT_MS} ahead", and those are two hours apart. A
 * minute leaves room for a slow machine and a container whose clock drifted.
 */
const CLOCK_TOLERANCE_MS = 60_000;

let chaos: ChaosScenario;

/**
 * How many times the server now running has been asked to redeem a refresh token.
 *
 * The point of asking is that every other assertion in the first test below is
 * also satisfied by a client that never needed to refresh at all — if the token
 * had not really expired, the listener would reconnect, the message would
 * arrive, and the test would pass while proving nothing. This is the assertion
 * that the failure under test actually happened.
 *
 * Read from Fastify's own request log rather than from a counter this suite
 * keeps, because the thing worth counting is what reached the server.
 *
 * @returns The number of `POST /auth/refresh` requests it has logged.
 */
function refreshCount(): number {
  return chaos
    .server()
    .records()
    .filter((record) => {
      const request = record['req'];
      if (typeof request !== 'object' || request === null) {
        return false;
      }
      const fields = request as Record<string, unknown>;
      return fields['method'] === 'POST' && fields['url'] === '/auth/refresh';
    }).length;
}

beforeAll(async () => {
  chaos = await createScenario('tokens');
}, SETUP_TIMEOUT_MS);

afterEach(async () => {
  chaos.clientRelay.refuse(false);
  chaos.clientRelay.resume();
  await chaos.stopListeners('SIGTERM');
}, SETTLE_TIMEOUT_MS);

afterAll(async () => {
  await chaos?.close();
}, SETTLE_TIMEOUT_MS);

describe('an access token that expires under a running listener', () => {
  it(
    'is refreshed without the listener stopping and without a message being dropped',
    async () => {
      const listener = await chaos.listenConnected(chaos.bob);

      // Baseline. Everything below is a claim about a *change*, so the pipe has
      // to be shown working before it is broken.
      const before = await chaos.send('Sent while the access token was fresh.');
      await listener.waitForMessage(before.messageId);
      await chaos.waitUntilAcknowledged(before.messageId);

      const connectionsBefore = listener
        .events()
        .filter((event) => event['event'] === 'status' && event['state'] === 'connected').length;

      // Every access token in the world is now two hours past its `exp`, as far
      // as the process holding the signing key is concerned. Neither client has
      // been told, and neither has any reason to look.
      await chaos.rotateServer({ clockShiftMs: CLOCK_SHIFT_MS });

      // Alice's turn first, on the HTTP path: one 401, one refresh, one retry,
      // and the caller is never told any of it happened (`packages/client/src/api.ts`).
      const during = await chaos.send('Sent with an access token that had expired.');
      expect(during.messageId).toEqual(expect.stringMatching(/^msg_/));

      // Bob's turn, on the WebSocket path. His listener was cut, will be refused
      // at the upgrade because its token is expired, will refresh, and will come
      // back — all without a person, and without exiting.
      const delivered = await listener.waitForMessage(during.messageId);
      expect(delivered['content']).toBe('Sent with an access token that had expired.');

      // Not dropped, and not duplicated: at-least-once on the wire, exactly once
      // out of `listen`'s stdout, which is what §10.2's client-side
      // deduplication is for.
      expect(
        listener.messages().filter((event) => event['messageId'] === during.messageId),
      ).toHaveLength(1);

      // Still the same process. A refresh that had been treated as a logout
      // would have ended it, and that is the failure this test is really about:
      // a harness that dies quietly an hour in.
      expect(listener.hasExited(), 'the listener exited rather than refreshing').toBe(false);

      // And it genuinely reconnected rather than merely surviving — a `connected`
      // status it did not have before the rotation.
      expect(
        listener
          .events()
          .filter((event) => event['event'] === 'status' && event['state'] === 'connected').length,
      ).toBeGreaterThan(connectionsBefore);

      // The renewed credential is a working credential, not merely an accepted
      // one: acknowledgement is a separate authenticated call.
      await chaos.waitUntilAcknowledged(during.messageId);

      // And the whole thing really did turn on an expiry. Two refusals were
      // answered with two refreshes — Alice's `send` on the HTTP path, and the
      // listener's upgrade on the WebSocket path — against a server that had
      // never issued either client a token. Without this, every assertion above
      // is equally true of a token that never expired.
      expect(
        refreshCount(),
        'no refresh token was redeemed, so nothing here was refused for being expired',
      ).toBeGreaterThanOrEqual(2);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does not let the skewed clock reach the message record',
    async () => {
      // The server accepting this send is still the one running two hours ahead,
      // left there by the test above.
      const listener = await chaos.listenConnected(chaos.bob);
      const sent = await chaos.send('Committed by a server whose clock is two hours fast.');
      const delivered = await listener.waitForMessage(sent.messageId);

      const createdAt = Date.parse(String(delivered['createdAt']));
      expect(
        Number.isNaN(createdAt),
        `unparseable createdAt: ${String(delivered['createdAt'])}`,
      ).toBe(false);

      // `messages.created_at` is `defaultNow()` — PostgreSQL's clock, not the
      // application's. A schema that stamped rows from the application clock
      // would put this message two hours in the future, and every consumer
      // ordering by it, every `--since`, and every inbox listing would be wrong
      // for as long as that node stayed in the fleet.
      expect(
        Math.abs(createdAt - Date.now()),
        `createdAt is ${String(delivered['createdAt'])}, which is not database time — ` +
          "the server's shifted application clock reached the record",
      ).toBeLessThan(CLOCK_TOLERANCE_MS);

      await chaos.waitUntilAcknowledged(sent.messageId);
    },
    TEST_TIMEOUT_MS,
  );
});
