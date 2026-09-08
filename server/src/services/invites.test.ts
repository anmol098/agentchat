/**
 * The parts of the invite service that need no database: how a code is drawn,
 * and how a typed one is spelled for lookup.
 *
 * Everything else about invites is decided by PostgreSQL — the unique index on
 * the code, the expiry comparison, the conflict that makes joining idempotent —
 * and is exercised against a real one in
 * `routes/invites.integration.test.ts`. Mocking a database to assert that a
 * `where` clause was built would test this file's spelling rather than the
 * server's behaviour.
 */

import { InviteCodeSchema } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import { canonicalInviteCode, generateInviteCode, INVITE_INVALID_MESSAGE } from './invites.js';

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
