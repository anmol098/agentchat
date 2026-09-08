/**
 * The parts of the project service that are decisions rather than queries.
 *
 * Slug derivation is a pure function of a string and is tested exhaustively
 * here, because it is the one piece of this task with rules of its own rather
 * than rules borrowed from the authorization service. Everything that touches
 * Postgres — the create transaction, the leave cleanup, the discovery join —
 * is proven in `projects.integration.test.ts` against a real database, where
 * the constraints being relied on actually exist.
 *
 * Two properties are asserted about every derived slug rather than about the
 * examples individually: it satisfies the contract's `ProjectSlugSchema`, and
 * it satisfies the stricter grammar the `projects_slug_format` check
 * constraint enforces. A derivation that produced `a--b` would pass the first
 * and fail the second at run time, as a 500.
 */

import { ErrorCode, ProjectSlugSchema, ProtocolError } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import { chooseProjectSlug, deriveProjectSlug } from './projects.js';

/**
 * The grammar `projects_slug_format` enforces, restated from
 * `db/schema/identity.ts`.
 *
 * Written out here rather than imported so this suite fails if the derivation
 * and the constraint stop agreeing, whichever of the two moved.
 */
const STORABLE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** The longest slug `ProjectSlugSchema` accepts. */
const MAX_LENGTH = 32;

/**
 * Asserts a slug is storable and on-contract.
 *
 * @param slug - The candidate.
 */
function expectUsable(slug: string): void {
  expect(ProjectSlugSchema.safeParse(slug).success).toBe(true);
  expect(slug).toMatch(STORABLE);
  expect(slug.length).toBeLessThanOrEqual(MAX_LENGTH);
}

/**
 * Runs a call expected to be refused and returns the error.
 *
 * @param run - The call.
 * @returns The `ProtocolError` it threw.
 * @throws {Error} If it did not throw, or threw something else.
 */
function refusal(run: () => unknown): ProtocolError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ProtocolError) {
      return error;
    }
    throw new Error(`Expected a ProtocolError, got: ${String(error)}`);
  }
  throw new Error('Expected this call to be refused, but it returned.');
}

describe('deriveProjectSlug', () => {
  it('lowercases and joins words with single hyphens', () => {
    expect(deriveProjectSlug('Payments Platform')).toBe('payments-platform');
  });

  it('collapses a run of punctuation into one hyphen, not one per character', () => {
    // The database rejects consecutive hyphens outright, so this is a
    // correctness rule rather than a tidiness one.
    expect(deriveProjectSlug('Payments — the Platform!!')).toBe('payments-the-platform');
    expect(deriveProjectSlug('a   b')).toBe('a-b');
  });

  it('keeps the letter when dropping its accent', () => {
    // `caf-solo` would be the result of deleting anything non-ASCII; NFKD plus
    // mark removal keeps the `e`, which is the letter the user typed.
    expect(deriveProjectSlug('Café Solo')).toBe('cafe-solo');
    expect(deriveProjectSlug('Ångström')).toBe('angstrom');
  });

  it('never starts or ends with a hyphen', () => {
    expect(deriveProjectSlug('  Payments  ')).toBe('payments');
    expect(deriveProjectSlug('---payments---')).toBe('payments');
    expect(deriveProjectSlug('#1 Project!')).toBe('1-project');
  });

  it('truncates to the contract length without leaving a trailing hyphen', () => {
    // 33 characters of word, then a boundary that would land on a hyphen.
    const derived = deriveProjectSlug('abcdefghijklmnopqrstuvwxyzabcdef ghi');
    expect(derived).toBe('abcdefghijklmnopqrstuvwxyzabcdef');
    expect(derived).not.toMatch(/-$/);
  });

  it('trims the hyphen truncation lands on', () => {
    // 32 characters of word, a hyphen at position 33: slicing to 32 is exact,
    // but one character shorter would end on the hyphen.
    const derived = deriveProjectSlug('abcdefghijklmnopqrstuvwxyzabcde fgh');
    expect(derived).toBe('abcdefghijklmnopqrstuvwxyzabcde');
  });

  it('returns undefined when there is nothing a slug can be made of', () => {
    // Not a random fallback: a handle nobody can guess is worse than being
    // asked for one. See `chooseProjectSlug`.
    expect(deriveProjectSlug('日本語')).toBeUndefined();
    expect(deriveProjectSlug('!!!')).toBeUndefined();
    expect(deriveProjectSlug('   ')).toBeUndefined();
    expect(deriveProjectSlug('')).toBeUndefined();
  });

  it('produces a slug the contract and the database both accept', () => {
    const names = [
      'Payments Platform',
      'Café Solo',
      '#1 Project!',
      'a  --  b',
      'ALL CAPS NAME',
      'trailing-hyphen-',
      '2026 roadmap',
      'abcdefghijklmnopqrstuvwxyzabcdef ghi',
    ];

    for (const name of names) {
      const slug = deriveProjectSlug(name);
      expect(slug, name).toBeDefined();
      expectUsable(slug as string);
    }
  });
});

describe('chooseProjectSlug', () => {
  it('derives from the name when none is given', () => {
    expect(chooseProjectSlug({ name: 'Payments Platform' })).toBe('payments-platform');
  });

  it('uses an explicit slug verbatim rather than re-deriving one', () => {
    // The caller commits this into `.agentchat/config.json` (D12). A slug that
    // came back different from the one sent would be a silent disagreement
    // between that file and the server.
    expect(chooseProjectSlug({ name: 'Payments Platform', slug: 'pay' })).toBe('pay');
  });

  it('asks for an explicit slug rather than inventing one', () => {
    const error = refusal(() => chooseProjectSlug({ name: '日本語' }));
    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
    expect(error.message).toContain('slug');
  });

  it('refuses a slug the database will not store', () => {
    // These two are why this check exists. `ProjectSlugSchema` used to be
    // `^[a-z0-9][a-z0-9-]{0,31}$`, which accepted both while
    // `projects_slug_format` refused them, so without the service-level check a
    // caller who sent one received a 500 from a constraint violation for a
    // request the server could see was malformed.
    //
    // T-025 has since narrowed the contract to the database's own grammar, so
    // the route now rejects these before they reach here and this check is a
    // second opinion rather than the only one. It is asserted, not deleted,
    // because `chooseProjectSlug` is exported and callable directly, and
    // because the failure it guards against is a 500.
    for (const slug of ['a--b', 'payments-']) {
      const error = refusal(() => chooseProjectSlug({ name: 'Payments', slug }));
      expect(error.code, slug).toBe(ErrorCode.BAD_REQUEST);
      expect(ProjectSlugSchema.safeParse(slug).success, slug).toBe(false);
    }
  });
});
