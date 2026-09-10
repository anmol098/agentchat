/**
 * The part of the inbox that is decided before a database is involved.
 *
 * `./inbox.integration.test.ts` proves D3 — that an acknowledgement from any
 * session of an agent clears the queue for that agent — because that is a claim
 * about rows and cannot be made anywhere else. What is left for here is the page
 * size, which is the one thing a caller can get wrong without a connection: the
 * clamp is what stops a client's own retry loop asking for a backlog larger than
 * the process can hold, and a test that needed a database to check it would be
 * testing the opposite of that claim.
 */

import { ErrorCode, ProtocolError } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';
import { HTTP_STATUS_BY_ERROR_CODE } from '../errors.js';
import { DEFAULT_PENDING_LIMIT, MAX_PENDING_LIMIT, resolvePendingLimit } from './inbox.js';

/**
 * Runs a resolution expected to fail and returns the error it threw.
 *
 * @param run - The resolution.
 * @returns The `ProtocolError`.
 * @throws {Error} If it passed, or threw something else. Either is a limit that
 *   is not enforced, which must not read as a pass.
 */
function refusal(run: () => void): ProtocolError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ProtocolError) {
      return error;
    }
    throw new Error(`Expected a ProtocolError, got: ${String(error)}`);
  }
  throw new Error('Expected this limit to be refused, but it was accepted.');
}

describe('the documented page size', () => {
  it('answers an absent limit with the default', () => {
    expect(resolvePendingLimit(undefined)).toBe(DEFAULT_PENDING_LIMIT);
  });

  it('honours a limit inside the ceiling', () => {
    expect(resolvePendingLimit(1)).toBe(1);
    expect(resolvePendingLimit(37)).toBe(37);
    expect(resolvePendingLimit(MAX_PENDING_LIMIT)).toBe(MAX_PENDING_LIMIT);
  });

  it('clamps rather than refuses above the ceiling', () => {
    // The ceiling is a fact about this server's memory, not a rule the caller
    // broke. A listener draining a backlog asks for more than it can be given
    // and is given what it can be given; refusing would make its retry loop the
    // thing that fails.
    expect(resolvePendingLimit(MAX_PENDING_LIMIT + 1)).toBe(MAX_PENDING_LIMIT);
    expect(resolvePendingLimit(1_000_000)).toBe(MAX_PENDING_LIMIT);
  });

  it('keeps the default inside the ceiling', () => {
    // Otherwise the documented default is a lie the clamp quietly corrects.
    expect(DEFAULT_PENDING_LIMIT).toBeLessThanOrEqual(MAX_PENDING_LIMIT);
    expect(DEFAULT_PENDING_LIMIT).toBeGreaterThan(0);
  });

  it('refuses a limit that is not a positive integer', () => {
    // These are bugs in whatever built the request rather than negotiations,
    // and turning them into a hundred would hide them.
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusal(() => resolvePendingLimit(bad)).code).toBe(ErrorCode.BAD_REQUEST);
    }
  });

  it('refuses with a status a client can act on', () => {
    const error = refusal(() => resolvePendingLimit(0));

    expect(HTTP_STATUS_BY_ERROR_CODE[error.code]).toBe(400);
  });
});
