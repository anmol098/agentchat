/**
 * **A listener left running overnight recovers on its own.**
 *
 * This is the property T-043 exists for, and the reason the missing
 * `POST /auth/refresh` was the worst of the three missing routes rather than
 * one of three equal ones. An access token lives an hour. The device flow
 * issued a refresh token beside it and there was nothing to spend it on, so
 * when the hour was up a running listener was finished: no amount of retrying
 * would recover it, and the only way back was a human at a browser completing
 * the device authorization again. A system whose whole point is that an agent
 * can be reached while nobody is watching cannot require somebody to be
 * watching.
 *
 * So the assertion here is not "the endpoint exists". It is that a process
 * which was working before the expiry is still working after it, having been
 * told nothing and asked nothing. Everything else in this file is there to stop
 * that claim being satisfied dishonestly:
 *
 * - the expired token is proved to be genuinely refused, so the survival cannot
 *   be the clock failing to move;
 * - the recovery is proved to have cost exactly one `POST /auth/refresh`, so it
 *   cannot be a client hammering a route that rotates on every call;
 * - it survives a *second* expiry, so it cannot be a one-shot that leaves the
 *   process holding a credential it can never rotate again;
 * - and the replaced refresh token is proved dead, so rotation is real.
 *
 * The client here is `@agentchat/client`, unmodified — the same library
 * `agentchat listen` runs on. Nothing in this file implements a retry, a
 * refresh, or a 401 handler. If those had to be written here, the test would be
 * proving something about the test.
 *
 * @module
 */

import { InMemoryCredentialStore } from '@agentchat/client';
import { RefreshTokensResponseSchema } from '@agentchat/protocol';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLOCK_SKEW_TOLERANCE_SECONDS,
} from '@agentchat/server/dist/src/auth/tokens.js';
import { afterEach, describe, expect, it } from 'vitest';

import { type ServerFixture, startServer } from './server-fixture.js';

/**
 * How far to jump to be certain an access token is dead.
 *
 * The TTL, plus the verifier's skew tolerance, plus a minute of margin. Landing
 * exactly on the boundary would make this suite's result depend on how long the
 * preceding lines took to run.
 */
const PAST_EXPIRY_SECONDS = ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS + 60;

let server: ServerFixture | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Reads the credentials a store currently holds, refusing to guess. */
async function credentialsIn(store: InMemoryCredentialStore) {
  const credentials = await store.load();
  if (credentials === null) {
    throw new Error('the credential store is empty; the login did not persist anything');
  }
  return credentials;
}

describe('surviving access-token expiry', () => {
  it('keeps working across an expiry with no human intervention', async () => {
    server = await startServer();

    // ---- Evening. A listener starts up and is working. --------------------
    const store = new InMemoryCredentialStore();
    const identity = await server.login(store);
    const client = server.client(store);

    const before = await client.auth.me();
    expect(before.username).toBe(identity.username);

    const issued = await credentialsIn(store);

    // ---- Overnight. Nobody is at the keyboard. ----------------------------
    server.advance(PAST_EXPIRY_SECONDS);

    // The access token the listener is holding is genuinely dead. Asserted
    // against the raw route, with no client in the way, because everything
    // below depends on this being true: if the clock had not really moved, the
    // "survival" further down would be the token simply still working.
    const withExpiredToken = await fetch(`${server.baseUrl}/me`, {
      headers: { authorization: `Bearer ${issued.accessToken}` },
    });
    expect(withExpiredToken.status).toBe(401);
    expect(await withExpiredToken.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });

    // ---- Morning. The listener carries on. --------------------------------
    //
    // Three calls at once, because that is what a woken-up process does: a
    // listener reconciles its session, its roster and its inbox together, and
    // `agentchat status` fans out three reads in one command. All three fail
    // with a stale 401 in the same tick, and the naive answer — "on a 401,
    // refresh" — would spend the same refresh token three times, which this
    // server reads as theft and answers by revoking the account. So this is
    // both the survival assertion and the assertion that survival is not
    // self-inflicted logout.
    const [first, second, third] = await Promise.all([
      client.auth.me(),
      client.auth.me(),
      client.auth.me(),
    ]);

    expect(first.id).toBe(before.id);
    expect(second.id).toBe(before.id);
    expect(third.id).toBe(before.id);

    // Exactly one, whatever the interleaving.
    expect(server.countOf('POST /auth/refresh')).toBe(1);

    // The recovery was real: the process is holding a different pair now, and
    // it persisted both halves. A client that stored only the new access token
    // would work this morning and be unrecoverable the next.
    const renewed = await credentialsIn(store);
    expect(renewed.accessToken).not.toBe(issued.accessToken);
    expect(renewed.refreshToken).not.toBe(issued.refreshToken);

    // ---- The next night, and every night after. ---------------------------
    //
    // A refresh that worked once and left the process holding a token it could
    // not rotate again would pass every assertion above and still die on the
    // second night. Durability is the property, not recovery.
    server.advance(PAST_EXPIRY_SECONDS);

    const nextMorning = await client.auth.me();
    expect(nextMorning.id).toBe(before.id);
    expect(server.countOf('POST /auth/refresh')).toBe(2);

    const rotatedAgain = await credentialsIn(store);
    expect(rotatedAgain.refreshToken).not.toBe(renewed.refreshToken);

    // Nothing above put a credential in the log. The refresh route handles two
    // of them per call, so this is the cheapest moment to check.
    const logs = server.logs();
    expect(logs).not.toContain(issued.refreshToken);
    expect(logs).not.toContain(renewed.refreshToken);
    expect(logs).not.toContain(rotatedAgain.refreshToken);
    expect(logs).not.toContain(rotatedAgain.accessToken);
  });

  it('spends the refresh token through the service that rotates it', async () => {
    server = await startServer();

    const store = new InMemoryCredentialStore();
    await server.login(store);
    const client = server.client(store);

    const issued = await credentialsIn(store);

    server.advance(PAST_EXPIRY_SECONDS);
    await client.auth.me();
    const renewed = await credentialsIn(store);

    // The token that was spent is dead. Rotation is not a detail of the route;
    // it is the reason the route cannot simply re-issue and hand back the same
    // refresh token, and a route that did would pass the survival test above.
    const replay = await fetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: issued.refreshToken }),
    });

    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });

    // And the replay was answered the way `auth/tokens.ts` answers a replay:
    // the whole chain revoked, committed before the error was raised, so the
    // credential the attacker did not have is dead too. This route did not
    // reimplement that and must not have caught it either — an error swallowed
    // into a retry here would advertise a credential the server has destroyed.
    expect(server.logs()).toContain('refresh token replayed');

    const afterRevocation = await fetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: renewed.refreshToken }),
    });
    expect(afterRevocation.status).toBe(401);
  });

  it('answers a refresh without any access token at all', async () => {
    server = await startServer();

    const store = new InMemoryCredentialStore();
    await server.login(store);
    const issued = await credentialsIn(store);

    // No `authorization` header, and past the expiry, so there is no valid
    // access token anywhere in this request. That is the whole situation the
    // route exists for, and requiring a bearer credential would have made it
    // unreachable in exactly that situation.
    server.advance(PAST_EXPIRY_SECONDS);

    const response = await fetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: issued.refreshToken }),
    });

    expect(response.status).toBe(200);

    // Parsed through the contract rather than read field by field: the route
    // promises `RefreshTokensResponseSchema`, and an extra field on the wire is
    // as much a defect as a missing one.
    const body = RefreshTokensResponseSchema.parse(await response.json());
    expect(body.refreshToken).not.toBe(issued.refreshToken);
    expect(body.accessToken).not.toBe(issued.accessToken);

    // Public means "answers without an access token", not "answers anybody". A
    // caller with no refresh token is refused here rather than by the guard.
    const empty = await fetch(`${server.baseUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'not-a-token-this-server-issued' }),
    });
    expect(empty.status).toBe(401);

    // Credentials must not be cacheable anywhere between here and the client.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('opens nothing else while opening refresh', async () => {
    server = await startServer();

    // The public list is exact rather than a prefix rule, so `/auth/refresh`
    // being reachable without a token says nothing about its neighbours. This
    // is the assertion that fails if somebody later relaxes it into one.
    const identity = await fetch(`${server.baseUrl}/me`);
    expect(identity.status).toBe(401);

    const logout = await fetch(`${server.baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: 'anything' }),
    });
    expect(logout.status).toBe(401);
  });
});
