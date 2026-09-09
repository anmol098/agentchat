/**
 * The parts of the invite service that need no database: how a code is drawn,
 * how a typed one is spelled for lookup, and what happens when an insert comes
 * back a collision.
 *
 * Everything else about invites is decided by PostgreSQL — the unique index on
 * the code, the expiry comparison, the conflict that makes joining idempotent —
 * and is exercised against a real one in
 * `routes/invites.integration.test.ts`. Mocking a database to assert that a
 * `where` clause was built would test this file's spelling rather than the
 * server's behaviour.
 *
 * The collision suite below is the one deliberate exception, and it is narrow
 * on purpose. A code collision needs two draws to agree in forty bits, so there
 * is no way to ask a real PostgreSQL for one inside a test — and the retry loop
 * is the difference between a coincidence and a 500 on a request the caller did
 * nothing wrong in making. What the fake stands in for is the *error* the
 * driver raises, not the query it was raised by: the double is asked only
 * whether it throws, never what SQL it received.
 */

import {
  ErrorCode,
  InviteCodeSchema,
  InviteId,
  ProjectId,
  ProtocolError,
  UserId,
} from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import type { AuthorizationService, ProjectAccess } from './authorization.js';
import {
  canonicalInviteCode,
  createInviteService,
  generateInviteCode,
  INVITE_INVALID_MESSAGE,
  INVITE_NOT_FOUND_MESSAGE,
  type InviteDatabase,
} from './invites.js';

/** The shape plan §2 documents: `ANET-7K4M-Q2P9`. */
const DOCUMENTED_FORMAT = /^ANET-[0-9A-Z]{4}-[0-9A-Z]{4}$/;

/** The symbols a code may contain, mirrored from the module under test. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Enough draws to see every symbol and to catch a structural mistake. */
const SAMPLE_SIZE = 2000;

describe('generateInviteCode', () => {
  it('produces the documented human-readable format', () => {
    for (let draw = 0; draw < 100; draw += 1) {
      expect(generateInviteCode()).toMatch(DOCUMENTED_FORMAT);
    }
  });

  it('produces codes the protocol and the database both accept', () => {
    const code = generateInviteCode();

    // The wire grammar, which is deliberately looser than the format above.
    expect(InviteCodeSchema.safeParse(code).success).toBe(true);

    // `project_invites_code_canonical`: upper case, 8 to 64 characters. A
    // generator that drifted from the check constraint would fail at the
    // insert, in production, as a 500 on a valid request.
    expect(code).toBe(code.toUpperCase());
    expect(code.length).toBeGreaterThanOrEqual(8);
    expect(code.length).toBeLessThanOrEqual(64);
  });

  it('draws only from the unambiguous alphabet', () => {
    const drawn = new Set<string>();

    for (let draw = 0; draw < SAMPLE_SIZE; draw += 1) {
      for (const symbol of generateInviteCode().replaceAll('-', '').slice('ANET'.length)) {
        drawn.add(symbol);
      }
    }

    // Nothing outside the alphabet, and in particular none of the four
    // characters Crockford drops: I and L look like 1, O looks like 0, and a
    // code is read off a screen and typed into a terminal.
    for (const symbol of drawn) {
      expect(ALPHABET).toContain(symbol);
    }
    expect(drawn.has('I')).toBe(false);
    expect(drawn.has('L')).toBe(false);
    expect(drawn.has('O')).toBe(false);
    expect(drawn.has('U')).toBe(false);

    // Every symbol reachable. A generator that could only ever emit half its
    // alphabet has half the entropy the module claims, and the claim is what
    // the security argument rests on.
    expect(drawn.size).toBe(ALPHABET.length);
  });

  it('is unbiased by construction: 256 is a multiple of the alphabet size', () => {
    // The module reduces a random byte modulo the alphabet. That is uniform
    // only because the alphabet divides 256 exactly. If somebody adds or
    // removes a symbol, this fails here rather than skewing codes silently.
    expect(256 % ALPHABET.length).toBe(0);
  });

  it('does not repeat itself', () => {
    const codes = new Set<string>();
    for (let draw = 0; draw < SAMPLE_SIZE; draw += 1) {
      codes.add(generateInviteCode());
    }

    // 40 bits against two thousand draws: a collision here would mean the
    // source is not what it claims to be, not bad luck.
    expect(codes.size).toBe(SAMPLE_SIZE);
  });
});

describe('canonicalInviteCode', () => {
  it('upper-cases what a human typed', () => {
    expect(canonicalInviteCode('anet-7k4m-q2p9')).toBe('ANET-7K4M-Q2P9');
    expect(canonicalInviteCode('AnEt-7K4m-Q2p9')).toBe('ANET-7K4M-Q2P9');
  });

  it('leaves a canonical code alone', () => {
    const code = generateInviteCode();
    expect(canonicalInviteCode(code)).toBe(code);
  });

  it('does not fold anything else', () => {
    // Hyphens are part of the code, not decoration to be stripped: the stored
    // spelling has them, and a lookup that removed them would match nothing
    // while looking as though it had been helpful.
    expect(canonicalInviteCode('anet7k4mq2p9')).toBe('ANET7K4MQ2P9');
  });
});

describe('the refusal every bad code gets', () => {
  it('says what to do next and nothing about why', () => {
    // The message is the whole disclosure surface of a failed lookup. It must
    // not name expiry, revocation or existence as the reason — see the module
    // note — and it must tell the reader what to do instead.
    expect(INVITE_INVALID_MESSAGE).toContain('not valid');
    expect(INVITE_INVALID_MESSAGE).toContain('fresh one');
    expect(INVITE_INVALID_MESSAGE).not.toMatch(/\bunknown\b|\bdoes not exist\b|\bno such\b/i);
  });
});

describe('the refusal a revocation of an unknown invite gets', () => {
  it('is one message for both ways an identifier can be wrong', () => {
    // "Belongs to a project you cannot see" and "never existed" are one
    // answer, so the wording must not distinguish them. It is scoped to the
    // project on purpose: the caller is already a member of that project, so
    // naming it discloses nothing they did not bring with them.
    expect(INVITE_NOT_FOUND_MESSAGE).toBe('No such invite in this project.');
    expect(INVITE_NOT_FOUND_MESSAGE).not.toMatch(/revok|expir|another project|belongs/i);
  });

  it('is not the message a bad code gets, because they are not the same mistake', () => {
    // A bad code is a credential that did not work, answered `INVITE_INVALID`
    // to anybody. A bad identifier is a member naming a row of their own
    // project wrongly, answered `NOT_FOUND`. Collapsing them would make the
    // revoke route say "ask whoever invited you for a fresh one" to the person
    // trying to withdraw the invite.
    expect(INVITE_NOT_FOUND_MESSAGE).not.toBe(INVITE_INVALID_MESSAGE);
  });
});

/**
 * A driver error shaped like the one `pg` raises for a duplicate key.
 *
 * The two fields the service actually reads: `code` is Postgres's
 * `unique_violation`, and `constraint` names which unique index was hit. It is
 * built here rather than imported so that a change to how the service
 * recognises a collision has to be made in two places, one of which is a test.
 *
 * @param constraint - The index name the driver reports.
 * @param wrapped - When true, the error arrives buried in a `cause`, as Drizzle
 *   delivers it.
 * @returns The error to throw from a fake insert.
 */
function uniqueViolation(constraint: string, wrapped = false): Error {
  const driverError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });

  return wrapped
    ? Object.assign(new Error('Failed query: insert into "project_invites"'), {
        cause: driverError,
      })
    : driverError;
}

/** Records every insert and throws whatever the script says for that attempt. */
interface FakeInserts {
  /** The `code` value each attempted insert carried, in order. */
  readonly codes: string[];
  /** The `expiresAt` each attempted insert carried, in order. */
  readonly expiries: Date[];
  /** The database handle to hand the service. */
  readonly db: InviteDatabase;
}

/**
 * A database double whose only behaviour is what an insert throws.
 *
 * @param outcomes - One entry per attempt: an error to throw, or `undefined` to
 *   let the insert succeed. Attempts past the end of the list succeed.
 * @returns The recorder and the handle. See {@link FakeInserts}.
 */
function fakeInserts(outcomes: readonly (Error | undefined)[]): FakeInserts {
  const codes: string[] = [];
  const expiries: Date[] = [];

  const db = {
    insert: () => ({
      values: (row: { code: string; expiresAt: Date }): Promise<void> => {
        const outcome = outcomes[codes.length];
        codes.push(row.code);
        expiries.push(row.expiresAt);
        return outcome === undefined ? Promise.resolve() : Promise.reject(outcome);
      },
    }),
  } as unknown as InviteDatabase;

  return { codes, expiries, db };
}

/** An authorization service that lets everyone through. */
const permissive = {
  assertProjectMember: (): Promise<ProjectAccess> => Promise.resolve({} as ProjectAccess),
} as unknown as AuthorizationService;

/** An authorization service that refuses everyone, as it would a non-member. */
const forbidding = {
  assertProjectMember: (): Promise<ProjectAccess> =>
    Promise.reject(
      new ProtocolError(ErrorCode.NOT_FOUND, 'No such project, or you are not a member of it.'),
    ),
} as unknown as AuthorizationService;

describe('minting when a code is already taken', () => {
  it('draws again rather than failing a request the caller made correctly', async () => {
    const { codes, db } = fakeInserts([uniqueViolation('project_invites_code_unique')]);
    const service = createInviteService({ db, authorization: permissive });

    const invite = await service.create(UserId.generate(), ProjectId.generate());

    // Two attempts, two different codes, and the caller sees a success. A
    // collision is a coincidence, not something they did.
    expect(codes).toHaveLength(2);
    expect(codes[0]).not.toBe(codes[1]);
    expect(invite.code).toBe(codes[1]);
  });

  it('recognises the violation through the wrapper Drizzle puts around it', async () => {
    const { codes, db } = fakeInserts([uniqueViolation('project_invites_code_unique', true)]);
    const service = createInviteService({ db, authorization: permissive });

    await service.create(UserId.generate(), ProjectId.generate());

    // Drizzle reports a query error with the driver's underneath, so matching
    // only the outermost error would have made the retry unreachable in
    // production while passing a test that threw the bare one.
    expect(codes).toHaveLength(2);
  });

  it('gives up rather than retrying forever', async () => {
    const violation = uniqueViolation('project_invites_code_unique');
    const { codes, db } = fakeInserts([violation, violation, violation, violation, violation]);
    const service = createInviteService({ db, authorization: permissive });

    // Five draws that all collide is not a coincidence, it is a broken
    // generator, and looping on one would turn a bug into a hung request.
    await expect(service.create(UserId.generate(), ProjectId.generate())).rejects.toBe(violation);
    expect(codes).toHaveLength(5);
  });

  it('does not retry a different unique constraint on the same table', async () => {
    // A future `unique (project_id, label)` is not a code collision, and
    // redrawing the code would never satisfy it — it would just make five
    // pointless inserts before reporting the same error.
    const other = uniqueViolation('project_invites_project_id_label_unique');
    const { codes, db } = fakeInserts([other]);
    const service = createInviteService({ db, authorization: permissive });

    await expect(service.create(UserId.generate(), ProjectId.generate())).rejects.toBe(other);
    expect(codes).toHaveLength(1);
  });

  it('does not retry an error that is not a unique violation at all', async () => {
    const outage = new Error('connection terminated unexpectedly');
    const { codes, db } = fakeInserts([outage]);
    const service = createInviteService({ db, authorization: permissive });

    await expect(service.create(UserId.generate(), ProjectId.generate())).rejects.toBe(outage);
    expect(codes).toHaveLength(1);
  });
});

describe('the policy a minted invite carries', () => {
  it('expires seven days from now, to the millisecond', async () => {
    const minted = new Date('2026-09-08T10:00:00.000Z');
    const { expiries, db } = fakeInserts([]);
    const service = createInviteService({ db, authorization: permissive, now: () => minted });

    const invite = await service.create(UserId.generate(), ProjectId.generate());

    // Plan §3. The integration suite can only bound this within a window,
    // because it runs against the wall clock; with an injected one the
    // arithmetic is exact, so a mistaken unit — seven hours, or seven days
    // counted in seconds — is caught here rather than by a reader noticing that
    // the window was generous.
    expect(invite.expiresAt).toBe('2026-09-15T10:00:00.000Z');
    expect(expiries[0]).toStrictEqual(new Date('2026-09-15T10:00:00.000Z'));
  });

  it('asks whether the caller is a member before drawing anything', async () => {
    const { codes, db } = fakeInserts([]);
    const service = createInviteService({ db, authorization: forbidding });

    await expect(service.create(UserId.generate(), ProjectId.generate())).rejects.toThrow(
      ProtocolError,
    );

    // Nothing was inserted, and — the reason this asserts on `codes` rather
    // than on the rejection alone — no code was even drawn. A non-member's
    // request must not consume entropy or leave a row behind.
    expect(codes).toStrictEqual([]);
  });
});

/**
 * A database double whose only behaviour is what a revoking `update` returns.
 *
 * @param rows - What the update's `returning` resolves to: one row when the
 *   invite belongs to the project, none when it does not.
 * @returns The count of updates attempted, and the handle to hand the service.
 */
function fakeUpdates(rows: readonly { id: string }[]): {
  readonly attempts: { count: number };
  readonly db: InviteDatabase;
} {
  const attempts = { count: 0 };

  const db = {
    update: () => ({
      set: () => ({
        where: () => ({
          returning: (): Promise<readonly { id: string }[]> => {
            attempts.count += 1;
            return Promise.resolve(rows);
          },
        }),
      }),
    }),
  } as unknown as InviteDatabase;

  return { attempts, db };
}

describe('revoking', () => {
  it('asks whether the caller is a member before writing anything', async () => {
    const { attempts, db } = fakeUpdates([{ id: 'inv_x' }]);
    const service = createInviteService({ db, authorization: forbidding });

    await expect(
      service.revoke(UserId.generate(), ProjectId.generate(), InviteId.generate()),
    ).rejects.toThrow(ProtocolError);

    // No update was attempted. A non-member must not be able to reach the row
    // at all — not to write it, and not to time a lookup against it.
    expect(attempts.count).toBe(0);
  });

  it('refuses an identifier that names no invite of this project', async () => {
    // An empty result is the only thing this can mean: the update matches on
    // identity rather than on `revoked_at is null`, so an already-revoked
    // invite still returns its row.
    const { db } = fakeUpdates([]);
    const service = createInviteService({ db, authorization: permissive });

    await expect(
      service.revoke(UserId.generate(), ProjectId.generate(), InviteId.generate()),
    ).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
      message: INVITE_NOT_FOUND_MESSAGE,
    });
  });

  it('answers with an empty body, so two revocations are indistinguishable', async () => {
    const { db } = fakeUpdates([{ id: 'inv_x' }]);
    const service = createInviteService({ db, authorization: permissive });

    const first = await service.revoke(
      UserId.generate(),
      ProjectId.generate(),
      InviteId.generate(),
    );
    const second = await service.revoke(
      UserId.generate(),
      ProjectId.generate(),
      InviteId.generate(),
    );

    expect(first).toStrictEqual({});
    expect(second).toStrictEqual(first);
  });

  it('takes one statement, so there is no window between reading and writing', async () => {
    const { attempts, db } = fakeUpdates([{ id: 'inv_x' }]);
    const service = createInviteService({ db, authorization: permissive });

    await service.revoke(UserId.generate(), ProjectId.generate(), InviteId.generate());

    // One `update ... returning`, not a select followed by an update. Two
    // statements would let a redemption slip between them, and would need a
    // transaction to close the gap that `coalesce` closes for free.
    expect(attempts.count).toBe(1);
  });
});

describe('the identifier a minted invite carries', () => {
  it('is the one that was inserted, so the caller can revoke by it', async () => {
    const inserted: string[] = [];
    const db = {
      insert: () => ({
        values: (row: { id: string }): Promise<void> => {
          inserted.push(row.id);
          return Promise.resolve();
        },
      }),
    } as unknown as InviteDatabase;

    const service = createInviteService({ db, authorization: permissive });
    const invite = await service.create(UserId.generate(), ProjectId.generate());

    expect(invite.id).toBe(inserted[0]);
    expect(invite.id).toMatch(/^inv_/);
  });

  it('is redrawn with the code when a collision forces a second attempt', async () => {
    const inserted: string[] = [];
    const outcomes = [uniqueViolation('project_invites_code_unique'), undefined];
    const db = {
      insert: () => ({
        values: (row: { id: string }): Promise<void> => {
          const outcome = outcomes[inserted.length];
          inserted.push(row.id);
          return outcome === undefined ? Promise.resolve() : Promise.reject(outcome);
        },
      }),
    } as unknown as InviteDatabase;

    const service = createInviteService({ db, authorization: permissive });
    const invite = await service.create(UserId.generate(), ProjectId.generate());

    // The retry inserts a different row, so returning the first attempt's
    // identifier would hand the caller one that names nothing.
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).not.toBe(inserted[1]);
    expect(invite.id).toBe(inserted[1]);
  });
});
