/**
 * The token service, tested against an in-memory store.
 *
 * ## Why not a database
 *
 * Every property this suite asserts is a property of the *service*: which
 * claims a token carries, what a replayed token does to the rest of the chain,
 * what survives a failure halfway through a rotation. None of those is a
 * property of PostgreSQL, and pinning them to a real database would make the
 * interesting cases — a rotation that fails between the revoke and the insert,
 * a token that expires between two calls — either impossible to arrange or slow
 * enough that nobody runs them.
 *
 * What the store *does* have to reproduce faithfully is the two guarantees the
 * service leans on, and {@link MemoryRefreshTokenStore} implements both rather
 * than stubbing them:
 *
 * - `claimForRotation` is a compare-and-swap. It revokes and returns a row only
 *   if that row is live, so calling it twice with the same hash succeeds once.
 * - `transaction` really rolls back. A snapshot is taken on entry and restored
 *   if the body throws, so "atomic" is something this suite can actually
 *   observe rather than something it takes on trust.
 *
 * The SQL that has to provide the same two guarantees is `operationsOn` in
 * `./tokens.ts`, and it is covered by the identity integration suite's real
 * PostgreSQL.
 *
 * @module
 */

import { ErrorCode, type MachineId, ProtocolError, SessionId, UserId } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import {
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenClaims,
  CLOCK_SKEW_TOLERANCE_SECONDS,
  createTokenService,
  generateRefreshToken,
  hashRefreshToken,
  type IssuedTokens,
  type NewRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
  type RefreshTokenReader,
  type RefreshTokenRecord,
  RefreshTokenReuseError,
  type RefreshTokenReuseEvent,
  type RefreshTokenStore,
  type RefreshTokenWriter,
  signAccessToken,
  type TokenService,
  TokenServiceConfigurationError,
  verifyAccessToken,
} from './tokens.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A secret long enough to be accepted. Not a real one. */
const SECRET = 'x'.repeat(64);

/**
 * The generic refresh rejection, written out rather than imported.
 *
 * `refreshTokenRejected` is module-private, and asserting against a copy of the
 * string is the point: this is the message that must stay byte-identical across
 * "never existed", "expired" and "logged out" (`docs/protocol.md` §3.2). A test
 * that imported the builder would agree with any reword, including one that
 * split the three apart.
 */
const GENERIC_REJECTION = 'This refresh token is not valid. Sign in again with: agentchat login';

/**
 * The reuse alarm, written out for the same reason.
 *
 * Its wording is deliberate — it tells a user their account is compromised —
 * and T-050 changed which cases reach it, not what it says.
 */
const REUSE_ALARM =
  'This refresh token has already been used. Every session for this account has been revoked ' +
  'as a precaution. Sign in again with: agentchat login';

/** The shape the database's `refresh_tokens_token_hash_is_sha256` check enforces. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One second, in milliseconds. */
const SECOND_MS = 1_000;

/** A fixed instant every test measures from, so no assertion depends on today. */
const T0 = new Date('2026-01-01T00:00:00.000Z');

/**
 * A clock the test moves by hand.
 *
 * Injected into the service, so expiry is asserted by advancing a variable
 * rather than by waiting an hour or by stubbing a global.
 */
class TestClock {
  #at: Date;

  public constructor(start: Date = T0) {
    this.#at = start;
  }

  /** Reads the current instant. Passed to the service as its `now`. */
  public readonly now = (): Date => this.#at;

  /**
   * Moves the clock forward.
   *
   * @param seconds - How far, in seconds.
   */
  public advance(seconds: number): void {
    this.#at = new Date(this.#at.getTime() + seconds * SECOND_MS);
  }
}

/**
 * An in-memory {@link RefreshTokenStore} with real compare-and-swap and real
 * rollback. See the module note.
 */
class MemoryRefreshTokenStore implements RefreshTokenStore {
  /** Rows by surrogate id. Values are replaced, never mutated in place. */
  #rows = new Map<string, RefreshTokenRecord>();

  /** Supplies surrogate keys, since there is no database to default them. */
  #nextId = 1;

  /**
   * Set to make the next {@link insert} throw, simulating a failure between the
   * two halves of a rotation.
   */
  public failNextInsert = false;

  /** Every row, in insertion order. For assertions only. */
  public get rows(): readonly RefreshTokenRecord[] {
    return [...this.#rows.values()];
  }

  /**
   * The row with this hash, if any.
   *
   * @param tokenHash - The digest to look for.
   * @returns The row, or `undefined`.
   */
  public rowFor(tokenHash: string): RefreshTokenRecord | undefined {
    return this.rows.find((row) => row.tokenHash === tokenHash);
  }

  public claimForRotation(tokenHash: string, now: Date): Promise<RefreshTokenRecord | undefined> {
    const row = this.rowFor(tokenHash);

    // The predicate is the whole point: revoked or expired rows do not match,
    // so the second caller presenting one token gets nothing.
    if (
      row === undefined ||
      row.revokedAt !== null ||
      row.expiresAt.getTime() <= now.getTime() - CLOCK_SKEW_TOLERANCE_SECONDS * SECOND_MS
    ) {
      return Promise.resolve(undefined);
    }

    // The reason is written with `revokedAt`, never separately, exactly as the
    // SQL writes them in one `SET`. A fake that set only one of the two would
    // let the service pass here and misclassify every row in production.
    const revoked: RefreshTokenRecord = { ...row, revokedAt: now, revokedReason: 'rotated' };
    this.#rows.set(row.id, revoked);
    return Promise.resolve(revoked);
  }

  public revokeByHash(tokenHash: string, now: Date): Promise<boolean> {
    const row = this.rowFor(tokenHash);
    if (row === undefined || row.revokedAt !== null) {
      return Promise.resolve(false);
    }

    this.#rows.set(row.id, { ...row, revokedAt: now, revokedReason: 'logout' });
    return Promise.resolve(true);
  }

  public revokeAllForUser(userId: UserId, now: Date): Promise<number> {
    let revoked = 0;
    for (const row of this.rows) {
      if (row.userId === userId && row.revokedAt === null) {
        this.#rows.set(row.id, { ...row, revokedAt: now, revokedReason: 'reuse_detected' });
        revoked += 1;
      }
    }
    return Promise.resolve(revoked);
  }

  public insert(token: NewRefreshToken): Promise<RefreshTokenRecord> {
    if (this.failNextInsert) {
      this.failNextInsert = false;
      return Promise.reject(new Error('simulated failure between revoke and issue'));
    }

    const id = `row-${this.#nextId}`;
    this.#nextId += 1;

    const row: RefreshTokenRecord = {
      id,
      userId: token.userId,
      tokenHash: token.tokenHash,
      createdAt: token.createdAt,
      expiresAt: token.expiresAt,
      revokedAt: null,
      revokedReason: null,
      machineId: token.machineId,
    };
    this.#rows.set(id, row);
    return Promise.resolve(row);
  }

  public findByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    return Promise.resolve(this.rowFor(tokenHash));
  }

  /**
   * Blanks a revoked row's reason, as if it had been written before the column
   * existed or by an older image running against the migrated schema.
   *
   * There is no other way to reach that state through the service, and it is
   * the state the whole expand step's safety rests on: `NULL` has to keep
   * meaning `'rotated'`.
   *
   * @param tokenHash - The digest of the row to blank.
   */
  public forgetRevocationReason(tokenHash: string): void {
    const row = this.rowFor(tokenHash);
    if (row === undefined) {
      throw new Error('no such row; the test is not arranging what it thinks it is');
    }
    this.#rows.set(row.id, { ...row, revokedReason: null });
  }

  public async transaction<T>(
    work: (tx: RefreshTokenWriter & RefreshTokenReader) => Promise<T>,
  ): Promise<T> {
    // Rows are replaced rather than mutated, so a copy of the map is a complete
    // snapshot. `#nextId` is deliberately not restored: a database would not
    // reuse a sequence value after a rollback either.
    const snapshot = new Map(this.#rows);
    try {
      return await work(this);
    } catch (error) {
      this.#rows = snapshot;
      throw error;
    }
  }
}

/** Everything a test needs to drive the service. */
interface Harness {
  /** The service under test. */
  readonly service: TokenService;
  /** Its store, for asserting on rows. */
  readonly store: MemoryRefreshTokenStore;
  /** Its clock, for expiring things. */
  readonly clock: TestClock;
  /** Every reuse event the service reported, in order. */
  readonly reuseEvents: RefreshTokenReuseEvent[];
}

/**
 * Builds a service over a fresh in-memory store.
 *
 * @returns The harness.
 */
function harness(): Harness {
  const store = new MemoryRefreshTokenStore();
  const clock = new TestClock();
  const reuseEvents: RefreshTokenReuseEvent[] = [];

  const service = createTokenService({
    store,
    jwtSecret: SECRET,
    now: clock.now,
    onReuseDetected: (event) => {
      reuseEvents.push(event);
    },
  });

  return { service, store, clock, reuseEvents };
}

/** A user id for tests. Generated so no two tests share one by accident. */
function someUser(): UserId {
  return UserId.generate();
}

/**
 * Asserts that a promise rejects with a `ProtocolError` carrying a code.
 *
 * @param promise - The call under test.
 * @param code - The expected code.
 * @returns The rejection, for further assertions.
 */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject, but it resolved');
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

describe('access tokens', () => {
  it('carries the documented claims and a one-hour expiry', async () => {
    const { service, clock } = harness();
    const userId = someUser();

    const issued = await service.issue({ userId });
    const claims = service.verifyAccessToken(issued.accessToken);

    expect(claims.sub).toBe(userId);
    expect(claims.exp - claims.iat).toBe(ACCESS_TOKEN_TTL_SECONDS);
    expect(claims.iat).toBe(Math.floor(clock.now().getTime() / SECOND_MS));
    expect(issued.accessTokenExpiresAt.getTime()).toBe(claims.exp * SECOND_MS);
  });

  it('omits the session claim when there is no session', async () => {
    const { service } = harness();

    const issued = await service.issue({ userId: someUser() });

    expect(service.verifyAccessToken(issued.accessToken).sid).toBeUndefined();
    // Not merely absent from the parsed claims: absent from the wire, so a
    // consumer reading the raw payload does not see `"sid":null`.
    expect(Object.keys(payloadOf(issued.accessToken))).toStrictEqual(['sub', 'iat', 'exp']);
  });

  it('carries the session claim when one is supplied', async () => {
    const { service } = harness();
    const sessionId = SessionId.generate();

    const issued = await service.issue({ userId: someUser(), sessionId });

    expect(service.verifyAccessToken(issued.accessToken).sid).toBe(sessionId);
  });

  it('is a JWS with an HS256 header', async () => {
    const { service } = harness();

    const issued = await service.issue({ userId: someUser() });
    const [header] = issued.accessToken.split('.') as [string];

    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toStrictEqual({
      alg: 'HS256',
      typ: 'JWT',
    });
  });
});

describe('access token verification', () => {
  it('rejects a token signed with a different secret', async () => {
    const { service } = harness();

    const issued = await service.issue({ userId: someUser() });

    expect(() => verifyAccessToken(issued.accessToken, 'y'.repeat(64))).toThrow(ProtocolError);
  });

  it('rejects a token whose payload was edited after signing', async () => {
    const { service } = harness();
    const issued = await service.issue({ userId: someUser() });
    const [header, , signature] = issued.accessToken.split('.') as [string, string, string];

    const forged = {
      ...payloadOf(issued.accessToken),
      sub: someUser(),
    };
    const tampered = `${header}.${Buffer.from(JSON.stringify(forged), 'utf8').toString(
      'base64url',
    )}.${signature}`;

    expect(() => service.verifyAccessToken(tampered)).toThrow(ProtocolError);
  });

  it('rejects an unsigned token claiming alg none', () => {
    // The classic algorithm-confusion attempt: a verifier that reads `alg` off
    // the token accepts this with an empty signature.
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' }), 'utf8').toString(
      'base64url',
    );
    const payload = Buffer.from(
      JSON.stringify({ sub: someUser(), iat: 0, exp: 9_999_999_999 }),
      'utf8',
    ).toString('base64url');

    expect(() => verifyAccessToken(`${header}.${payload}.`, SECRET)).toThrow(ProtocolError);
  });

  it('rejects a string that is not a compact JWS', () => {
    for (const candidate of ['', 'not-a-token', 'a.b', 'a.b.c.d']) {
      expect(() => verifyAccessToken(candidate, SECRET)).toThrow(ProtocolError);
    }
  });

  it('rejects a validly signed token whose subject is not a user id', () => {
    const claims = {
      sub: 'agt_0194f0a0-0000-7000-8000-000000000000',
      iat: 0,
      exp: 9_999_999_999,
    } as unknown as AccessTokenClaims;

    expect(() => verifyAccessToken(signAccessToken(claims, SECRET), SECRET)).toThrow(ProtocolError);
  });

  it('answers every failure with AUTH_REQUIRED and no internal detail', () => {
    const failure = attempt(() => verifyAccessToken('not-a-token', SECRET));

    expect(failure).toBeInstanceOf(ProtocolError);
    expect((failure as ProtocolError).code).toBe(ErrorCode.AUTH_REQUIRED);
    expect((failure as ProtocolError).message).not.toContain('not-a-token');
  });
});

describe('access token expiry', () => {
  it('accepts a token until its hour is up', async () => {
    const { service, clock } = harness();
    const issued = await service.issue({ userId: someUser() });

    clock.advance(ACCESS_TOKEN_TTL_SECONDS - 1);

    expect(() => service.verifyAccessToken(issued.accessToken)).not.toThrow();
  });

  it('tolerates a clock a minute out rather than logging the user out', async () => {
    const { service, clock } = harness();
    const issued = await service.issue({ userId: someUser() });

    // Past `exp`, inside the skew allowance. A verifier without the allowance
    // rejects this, which is the intermittent logout the constant exists to
    // prevent.
    clock.advance(ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS - 1);

    expect(() => service.verifyAccessToken(issued.accessToken)).not.toThrow();
  });

  it('rejects a token once it is expired beyond the skew allowance', async () => {
    const { service, clock } = harness();
    const issued = await service.issue({ userId: someUser() });

    clock.advance(ACCESS_TOKEN_TTL_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS);

    const failure = attempt(() => service.verifyAccessToken(issued.accessToken));
    expect((failure as ProtocolError).code).toBe(ErrorCode.AUTH_REQUIRED);
  });

  it('rejects a token issued further in the future than the skew allowance', () => {
    const nowSeconds = Math.floor(T0.getTime() / SECOND_MS);
    const claims: AccessTokenClaims = {
      sub: someUser(),
      iat: nowSeconds + CLOCK_SKEW_TOLERANCE_SECONDS + 1,
      exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    };

    expect(() => verifyAccessToken(signAccessToken(claims, SECRET), SECRET, T0)).toThrow(
      ProtocolError,
    );
  });
});

// ---------------------------------------------------------------------------
// Refresh tokens: shape and storage
// ---------------------------------------------------------------------------

describe('refresh tokens', () => {
  it('is 32 bytes of entropy, and two of them differ', () => {
    const first = generateRefreshToken();
    const second = generateRefreshToken();

    expect(Buffer.from(first, 'base64url')).toHaveLength(32);
    expect(first).not.toBe(second);
  });

  it('hashes to the 64 lowercase hex characters the schema constraint requires', () => {
    // `refresh_tokens_token_hash_is_sha256` rejects anything else, so this is
    // the application's half of a promise the database also enforces.
    expect(hashRefreshToken(generateRefreshToken())).toMatch(SHA256_HEX);
  });

  it('is stored only as its hash, never in plaintext', async () => {
    const { service, store } = harness();

    const issued = await service.issue({ userId: someUser() });

    expect(JSON.stringify(store.rows)).not.toContain(issued.refreshToken);
    expect(store.rows[0]?.tokenHash).toBe(hashRefreshToken(issued.refreshToken));
    expect(store.rows[0]?.tokenHash).toMatch(SHA256_HEX);
  });

  it('expires ninety days after it is issued', async () => {
    const { service } = harness();

    const issued = await service.issue({ userId: someUser() });

    expect(issued.refreshTokenExpiresAt.getTime() - T0.getTime()).toBe(
      REFRESH_TOKEN_TTL_SECONDS * SECOND_MS,
    );
  });

  it('does not disturb the tokens a user already holds', async () => {
    // Logging in on a second laptop must not sign the first one out.
    const { service, store } = harness();
    const userId = someUser();

    const first = await service.issue({ userId });
    await service.issue({ userId });

    expect(store.rowFor(hashRefreshToken(first.refreshToken))?.revokedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('rotation', () => {
  it('issues a new pair and revokes the one just spent', async () => {
    const { service, store } = harness();
    const first = await service.issue({ userId: someUser() });

    const second = await service.refresh(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(store.rowFor(hashRefreshToken(first.refreshToken))?.revokedAt).toStrictEqual(T0);
    expect(store.rowFor(hashRefreshToken(second.refreshToken))?.revokedAt).toBeNull();
  });

  it('leaves exactly one live token for the user', async () => {
    const { service, store } = harness();
    const userId = someUser();
    const first = await service.issue({ userId });

    await service.refresh(first.refreshToken);

    expect(store.rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
  });

  it('keeps the access token pointing at the same user', async () => {
    const { service } = harness();
    const userId = someUser();
    const first = await service.issue({ userId });

    const second = await service.refresh(first.refreshToken);

    expect(service.verifyAccessToken(second.accessToken).sub).toBe(userId);
  });

  it('restarts the ninety days rather than inheriting the old expiry', async () => {
    const { service, clock } = harness();
    const first = await service.issue({ userId: someUser() });

    clock.advance(30 * 24 * 60 * 60);
    const second = await service.refresh(first.refreshToken);

    expect(second.refreshTokenExpiresAt.getTime() - clock.now().getTime()).toBe(
      REFRESH_TOKEN_TTL_SECONDS * SECOND_MS,
    );
  });

  it('carries the machine through the rotation', async () => {
    // Without this, rotation would erase which device a credential belongs to
    // and `agentchat status` would lose track of it once T-301 lands.
    const { service, store } = harness();
    const machineId = 'mch_0194f0a0-0000-7000-8000-000000000000' as MachineId;
    const first = await service.issue({ userId: someUser(), machineId });

    const second = await service.refresh(first.refreshToken);

    expect(store.rowFor(hashRefreshToken(second.refreshToken))?.machineId).toBe(machineId);
  });

  it('is atomic: a failure between the revoke and the issue leaves the old token live', async () => {
    // The scenario the transaction exists for. Without a rollback the user is
    // holding a token the server has revoked and has not been given a
    // replacement — logged out, with a credential that still looks fine.
    const { service, store } = harness();
    const first = await service.issue({ userId: someUser() });
    store.failNextInsert = true;

    await expect(service.refresh(first.refreshToken)).rejects.toThrow(
      'simulated failure between revoke and issue',
    );

    expect(store.rowFor(hashRefreshToken(first.refreshToken))?.revokedAt).toBeNull();
    expect(store.rows).toHaveLength(1);

    // And the client's retry works, which is the point of rolling back to
    // "still live" rather than to anything else.
    await expect(service.refresh(first.refreshToken)).resolves.toBeDefined();
  });

  it('never leaves two live tokens for one chain', async () => {
    const { service, store } = harness();
    let current: IssuedTokens = await service.issue({ userId: someUser() });

    for (let round = 0; round < 5; round += 1) {
      current = await service.refresh(current.refreshToken);
      expect(store.rows.filter((row) => row.revokedAt === null)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Rejection
// ---------------------------------------------------------------------------

describe('refresh rejection', () => {
  it('rejects a token nobody ever issued, without revoking anything', async () => {
    const { service, store } = harness();
    const live = await service.issue({ userId: someUser() });

    const failure = await rejectionOf(service.refresh(generateRefreshToken()));

    expect(failure).toBeInstanceOf(ProtocolError);
    expect(failure).not.toBeInstanceOf(RefreshTokenReuseError);
    expect((failure as ProtocolError).code).toBe(ErrorCode.AUTH_REQUIRED);
    expect(store.rowFor(hashRefreshToken(live.refreshToken))?.revokedAt).toBeNull();
  });

  it('rejects an expired token as expired, not as a replay', async () => {
    // Ninety days of not running `agentchat` is not an attack, and answering it
    // by revoking the account's other sessions would be one.
    const { service, store, clock, reuseEvents } = harness();
    const userId = someUser();
    const stale = await service.issue({ userId });

    clock.advance(REFRESH_TOKEN_TTL_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS);
    const fresh = await service.issue({ userId });

    const failure = await rejectionOf(service.refresh(stale.refreshToken));

    expect(failure).not.toBeInstanceOf(RefreshTokenReuseError);
    expect((failure as ProtocolError).code).toBe(ErrorCode.AUTH_REQUIRED);
    expect(reuseEvents).toHaveLength(0);
    expect(store.rowFor(hashRefreshToken(fresh.refreshToken))?.revokedAt).toBeNull();
    // The expired row is left as it was: it was never spent, so nothing about
    // it should say it was.
    expect(store.rowFor(hashRefreshToken(stale.refreshToken))?.revokedAt).toBeNull();
  });

  it('says nothing about whether an unusable token ever existed', async () => {
    const { service, clock } = harness();
    const expired = await service.issue({ userId: someUser() });
    clock.advance(REFRESH_TOKEN_TTL_SECONDS + CLOCK_SKEW_TOLERANCE_SECONDS);

    const unknown = await rejectionOf(service.refresh(generateRefreshToken()));
    const stale = await rejectionOf(service.refresh(expired.refreshToken));

    // Identical answers: distinguishing them tells somebody probing with
    // harvested strings which of them were once real.
    expect((stale as ProtocolError).message).toBe((unknown as ProtocolError).message);
  });
});

// ---------------------------------------------------------------------------
// Reuse detection
// ---------------------------------------------------------------------------

describe('reuse detection', () => {
  it('kills the whole chain, including the token issued after the replayed one', async () => {
    // The scenario in full: issue, rotate, then present the spent token. The
    // newest token has to die too — it may be the attacker's, and there is no
    // way to tell which of the two holders is the legitimate one.
    const { service, store } = harness();
    const userId = someUser();

    const first = await service.issue({ userId });
    const second = await service.refresh(first.refreshToken);
    const third = await service.refresh(second.refreshToken);

    const failure = await rejectionOf(service.refresh(first.refreshToken));

    expect(failure).toBeInstanceOf(RefreshTokenReuseError);
    expect(store.rows.filter((row) => row.revokedAt === null)).toHaveLength(0);
    expect(store.rowFor(hashRefreshToken(third.refreshToken))?.revokedAt).not.toBeNull();

    // And the newest token is genuinely unusable afterwards, which is the part
    // that actually locks the attacker out.
    await expect(service.refresh(third.refreshToken)).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );
  });

  it('reports AUTH_REQUIRED on the wire and the reason internally', async () => {
    // The wire code is what the shipped client branches on to clear its stored
    // credentials; the class is how the server tells a replay from an ordinary
    // expiry without matching on a message.
    const { service } = harness();
    const first = await service.issue({ userId: someUser() });
    await service.refresh(first.refreshToken);

    const failure = (await rejectionOf(
      service.refresh(first.refreshToken),
    )) as RefreshTokenReuseError;

    expect(failure.code).toBe(ErrorCode.AUTH_REQUIRED);
    expect(failure.reason).toBe('refresh_token_reuse');
    expect(failure.message).not.toContain(first.refreshToken);
  });

  it('reports the event so the replay is not just another 401 in the access log', async () => {
    const { service, clock, reuseEvents } = harness();
    const userId = someUser();
    const first = await service.issue({ userId });
    await service.issue({ userId });
    const second = await service.refresh(first.refreshToken);
    const spentAt = clock.now();

    clock.advance(10);
    await rejectionOf(service.refresh(first.refreshToken));

    expect(reuseEvents).toStrictEqual([{ userId, revokedCount: 2, originallyRevokedAt: spentAt }]);
    expect(second.refreshToken).toBeDefined();
  });

  it('still revokes the chain when the reuse listener throws', async () => {
    const store = new MemoryRefreshTokenStore();
    const service = createTokenService({
      store,
      jwtSecret: SECRET,
      onReuseDetected: () => {
        throw new Error('the logger is broken');
      },
    });
    const first = await service.issue({ userId: someUser() });
    await service.refresh(first.refreshToken);

    const failure = await rejectionOf(service.refresh(first.refreshToken));

    expect(failure).toBeInstanceOf(RefreshTokenReuseError);
    expect(store.rows.filter((row) => row.revokedAt === null)).toHaveLength(0);
  });

  it('leaves other accounts alone', async () => {
    const { service, store } = harness();
    const victim = someUser();
    const bystander = someUser();

    const first = await service.issue({ userId: victim });
    const untouched = await service.issue({ userId: bystander });
    await service.refresh(first.refreshToken);

    await rejectionOf(service.refresh(first.refreshToken));

    expect(store.rowFor(hashRefreshToken(untouched.refreshToken))?.revokedAt).toBeNull();
  });

  it('treats a second refresh with the same token as a replay', async () => {
    // Two requests racing on one token reach the store one after the other; the
    // second finds it spent. The client serialises refreshes for exactly this
    // reason — see `packages/client/src/tokens.ts`.
    const { service } = harness();
    const first = await service.issue({ userId: someUser() });

    const [winner, loser] = await Promise.allSettled([
      service.refresh(first.refreshToken),
      service.refresh(first.refreshToken),
    ]);

    expect(winner.status).toBe('fulfilled');
    expect(loser.status).toBe('rejected');
    expect((loser as PromiseRejectedResult).reason).toBeInstanceOf(RefreshTokenReuseError);
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

describe('logout', () => {
  it('revokes the token it was given', async () => {
    const { service, store } = harness();
    const issued = await service.issue({ userId: someUser() });

    await expect(service.logout(issued.refreshToken)).resolves.toBe(true);

    expect(store.rowFor(hashRefreshToken(issued.refreshToken))?.revokedAt).toStrictEqual(T0);
  });

  it('leaves the account’s other sessions signed in', async () => {
    const { service, store } = harness();
    const userId = someUser();
    const laptop = await service.issue({ userId });
    const desktop = await service.issue({ userId });

    await service.logout(laptop.refreshToken);

    expect(store.rowFor(hashRefreshToken(desktop.refreshToken))?.revokedAt).toBeNull();
  });

  it('succeeds on a token it has already forgotten', async () => {
    // `LogoutResponseSchema` promises idempotence: a client that cannot log out
    // is stuck holding credentials it can no longer use.
    const { service } = harness();
    const issued = await service.issue({ userId: someUser() });
    await service.logout(issued.refreshToken);

    await expect(service.logout(issued.refreshToken)).resolves.toBe(false);
    await expect(service.logout(generateRefreshToken())).resolves.toBe(false);
  });

  it('does not trip reuse detection, so logging out twice keeps other sessions', async () => {
    // Logging out twice is a careful client, not an attack. Answering it by
    // revoking the account's other sessions would be a self-inflicted outage.
    const { service, store, reuseEvents } = harness();
    const userId = someUser();
    const laptop = await service.issue({ userId });
    const desktop = await service.issue({ userId });

    await service.logout(laptop.refreshToken);
    await service.logout(laptop.refreshToken);

    expect(reuseEvents).toHaveLength(0);
    expect(store.rowFor(hashRefreshToken(desktop.refreshToken))?.revokedAt).toBeNull();
  });

  it('makes the revoked token unusable for a refresh, without crying theft', async () => {
    // Presenting a logged-out token to `refresh` is not a replay: it was never
    // spent, so no successor exists and nothing is redeemable by anybody. The
    // row records `'logout'` as the reason, which is what lets the service say
    // so. It is still refused, with the ordinary rejection.
    const { service } = harness();
    const issued = await service.issue({ userId: someUser() });
    await service.logout(issued.refreshToken);

    const failure = await rejectionOf(service.refresh(issued.refreshToken));

    expect(failure).toBeInstanceOf(ProtocolError);
    expect(failure).not.toBeInstanceOf(RefreshTokenReuseError);
    expect((failure as ProtocolError).code).toBe(ErrorCode.AUTH_REQUIRED);
  });
});

// ---------------------------------------------------------------------------
// Logout, retried against `refresh` (T-050)
// ---------------------------------------------------------------------------

describe('a logged-out token redeemed at refresh', () => {
  it('is refused calmly, and signs nothing else out', async () => {
    // The defect this suite exists for. A dropped connection, a re-run script
    // or a second press of the button used to revoke every other session on
    // the account and log a replay warning that was simply false.
    const { service, store, clock, reuseEvents } = harness();
    const userId = someUser();
    const laptop = await service.issue({ userId });
    const desktop = await service.issue({ userId });

    await service.logout(laptop.refreshToken);
    clock.advance(5);
    const failure = await rejectionOf(service.refresh(laptop.refreshToken));

    expect(failure).toBeInstanceOf(ProtocolError);
    expect(failure).not.toBeInstanceOf(RefreshTokenReuseError);
    expect((failure as ProtocolError).code).toBe(ErrorCode.AUTH_REQUIRED);
    expect((failure as ProtocolError).message).toBe(GENERIC_REJECTION);

    // The two things the alarm used to do, and must not: revoke the account's
    // other machines, and report a security incident that did not happen.
    expect(store.rowFor(hashRefreshToken(desktop.refreshToken))?.revokedAt).toBeNull();
    expect(reuseEvents).toHaveLength(0);

    // And the untouched session is genuinely still usable, which is the part
    // the user would have noticed.
    await expect(service.refresh(desktop.refreshToken)).resolves.toBeDefined();
  });

  it('answers exactly as it answers a string that was never a token', async () => {
    // The section 3.2 property, and the one a later "more helpful" reword would
    // break: a distinct message here would tell anybody holding a harvested
    // string that it had once been real.
    const { service } = harness();
    const issued = await service.issue({ userId: someUser() });
    await service.logout(issued.refreshToken);

    const loggedOut = await rejectionOf(service.refresh(issued.refreshToken));
    const unknown = await rejectionOf(service.refresh(generateRefreshToken()));

    expect((loggedOut as ProtocolError).message).toBe((unknown as ProtocolError).message);
    expect((loggedOut as ProtocolError).code).toBe((unknown as ProtocolError).code);
    expect((loggedOut as ProtocolError).message).toBe(GENERIC_REJECTION);
  });

  it('stays calm however many times the client retries', async () => {
    const { service, store, reuseEvents } = harness();
    const userId = someUser();
    const laptop = await service.issue({ userId });
    const desktop = await service.issue({ userId });

    await service.logout(laptop.refreshToken);
    await rejectionOf(service.refresh(laptop.refreshToken));
    await rejectionOf(service.refresh(laptop.refreshToken));
    await rejectionOf(service.refresh(laptop.refreshToken));

    expect(reuseEvents).toHaveLength(0);
    expect(store.rowFor(hashRefreshToken(desktop.refreshToken))?.revokedAt).toBeNull();
  });

  it('records the reason on the row, rather than leaving it to be inferred', async () => {
    // The acceptance criterion in the task file: distinguishable *in the data*.
    // Successor existence would have discriminated the two cases today and
    // broken on a clock collision or a change to `mint`.
    const { service, store } = harness();
    const rotatedAway = await service.issue({ userId: someUser() });
    const loggedOut = await service.issue({ userId: someUser() });

    await service.refresh(rotatedAway.refreshToken);
    await service.logout(loggedOut.refreshToken);

    expect(store.rowFor(hashRefreshToken(rotatedAway.refreshToken))?.revokedReason).toBe('rotated');
    expect(store.rowFor(hashRefreshToken(loggedOut.refreshToken))?.revokedReason).toBe('logout');
  });

  it('cannot be laundered by logging out a token a rotation already spent', async () => {
    // `revokeByHash` predicates on `revoked_at IS NULL`, so a logout arriving
    // after a rotation changes nothing. Without that, an attacker who spent a
    // stolen token could call `POST /auth/logout` with it and relabel the row,
    // silencing the alarm the legitimate client's next refresh would raise.
    const { service, store } = harness();
    const first = await service.issue({ userId: someUser() });
    await service.refresh(first.refreshToken);

    await expect(service.logout(first.refreshToken)).resolves.toBe(false);

    expect(store.rowFor(hashRefreshToken(first.refreshToken))?.revokedReason).toBe('rotated');
    await expect(service.refresh(first.refreshToken)).rejects.toBeInstanceOf(
      RefreshTokenReuseError,
    );
  });
});

// ---------------------------------------------------------------------------
// The alarm, unchanged (T-050)
// ---------------------------------------------------------------------------

describe('a genuine replay, after the logout case was split out', () => {
  it('still revokes the chain, still reports, and still says exactly what it said', async () => {
    const { service, store, clock, reuseEvents } = harness();
    const userId = someUser();
    const first = await service.issue({ userId });
    const other = await service.issue({ userId });
    const second = await service.refresh(first.refreshToken);
    const spentAt = clock.now();

    clock.advance(10);
    const failure = await rejectionOf(service.refresh(first.refreshToken));

    expect(failure).toBeInstanceOf(RefreshTokenReuseError);
    expect((failure as RefreshTokenReuseError).message).toBe(REUSE_ALARM);
    expect((failure as RefreshTokenReuseError).revokedCount).toBe(2);
    expect(reuseEvents).toStrictEqual([{ userId, revokedCount: 2, originallyRevokedAt: spentAt }]);

    // Everything live is dead, including the session that was minding its own
    // business: a replay says a credential for this account has escaped, not
    // which copy is the attacker's.
    expect(store.rows.filter((row) => row.revokedAt === null)).toHaveLength(0);
    expect(store.rowFor(hashRefreshToken(second.refreshToken))?.revokedReason).toBe(
      'reuse_detected',
    );
    expect(store.rowFor(hashRefreshToken(other.refreshToken))?.revokedReason).toBe(
      'reuse_detected',
    );
  });

  it('tells a surviving client the truth without cascading a second time', async () => {
    // The bystander's own token was revoked by the detection, not by a
    // rotation. It gets the alarm, which is true — the account really was
    // locked down — but one incident must not produce one alert per client,
    // and there is nothing left to revoke.
    const { service, reuseEvents } = harness();
    const userId = someUser();
    const first = await service.issue({ userId });
    const bystander = await service.issue({ userId });
    await service.refresh(first.refreshToken);
    await rejectionOf(service.refresh(first.refreshToken));
    expect(reuseEvents).toHaveLength(1);

    const failure = await rejectionOf(service.refresh(bystander.refreshToken));

    expect(failure).toBeInstanceOf(RefreshTokenReuseError);
    expect((failure as RefreshTokenReuseError).message).toBe(REUSE_ALARM);
    expect((failure as RefreshTokenReuseError).revokedCount).toBe(0);
    expect(reuseEvents).toHaveLength(1);
  });

  it('reads a row with no recorded reason as a rotation, so the alarm still fires', async () => {
    // Rows revoked before the column existed, and rows an N-1 image revokes
    // against the migrated schema, both carry NULL. Reading NULL as `'rotated'`
    // is what makes the expand step a no-op for existing data, and it fails
    // towards an alarm that may be spurious rather than towards a silent one.
    const { service, store, reuseEvents } = harness();
    const userId = someUser();
    const first = await service.issue({ userId });
    const other = await service.issue({ userId });
    await service.refresh(first.refreshToken);
    store.forgetRevocationReason(hashRefreshToken(first.refreshToken));

    const failure = await rejectionOf(service.refresh(first.refreshToken));

    expect(failure).toBeInstanceOf(RefreshTokenReuseError);
    expect(reuseEvents).toHaveLength(1);
    expect(store.rowFor(hashRefreshToken(other.refreshToken))?.revokedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('createTokenService', () => {
  it('refuses to sign with a secret short enough to brute force', () => {
    expect(() =>
      createTokenService({ store: new MemoryRefreshTokenStore(), jwtSecret: 'short' }),
    ).toThrow(TokenServiceConfigurationError);
  });

  it('never puts the secret in the message it throws', () => {
    const secret = 'hunter2';
    const failure = attempt(() =>
      createTokenService({ store: new MemoryRefreshTokenStore(), jwtSecret: secret }),
    );

    expect((failure as Error).message).not.toContain(secret);
  });

  it('defaults to the wall clock when none is supplied', async () => {
    const service = createTokenService({
      store: new MemoryRefreshTokenStore(),
      jwtSecret: SECRET,
    });

    const issued = await service.issue({ userId: someUser() });

    expect(service.verifyAccessToken(issued.accessToken).iat * SECOND_MS).toBeGreaterThan(
      Date.now() - 60 * SECOND_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// Helpers used above
// ---------------------------------------------------------------------------

/**
 * Decodes a token's payload without verifying it.
 *
 * @param token - A compact JWS serialization.
 * @returns The payload as a plain object.
 */
function payloadOf(token: string): Record<string, unknown> {
  const [, payload] = token.split('.') as [string, string];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
}

/**
 * Runs a function and returns whatever it threw.
 *
 * @param run - The call under test.
 * @returns The thrown value.
 */
function attempt(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, but it returned');
}
