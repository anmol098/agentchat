/**
 * The part of the conversation read that needs no database.
 *
 * The read itself is proved against a real PostgreSQL in
 * `../routes/conversations.integration.test.ts`, because the whole of it is a
 * `WHERE` clause and a mock would be mocking the thing under test. What is left
 * here is the page-size contract — a documented default and a documented
 * maximum, which T-305's acceptance criteria name — and the boundary between a
 * value that is clamped and a value that is refused.
 */

import { ErrorCode, ProtocolError } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CONVERSATION_LIMIT,
  MAX_CONVERSATION_LIMIT,
  resolveConversationLimit,
} from './conversations.js';

describe('the page size', () => {
  it('is the documented default when the caller does not choose', () => {
    expect(resolveConversationLimit(undefined)).toBe(DEFAULT_CONVERSATION_LIMIT);
  });

  it('is what the caller asked for when that is within the ceiling', () => {
    expect(resolveConversationLimit(10)).toBe(10);
    expect(resolveConversationLimit(MAX_CONVERSATION_LIMIT)).toBe(MAX_CONVERSATION_LIMIT);
  });

  // Clamped rather than refused: the ceiling is a property of the server's
  // memory, not a rule about the request, and refusing would make a client's
  // own paging loop the thing that breaks.
  it('is clamped rather than refused when the caller asks for more', () => {
    expect(resolveConversationLimit(MAX_CONVERSATION_LIMIT + 1)).toBe(MAX_CONVERSATION_LIMIT);
    expect(resolveConversationLimit(1_000_000)).toBe(MAX_CONVERSATION_LIMIT);
  });

  // A limit of zero is a request for nothing and a fraction is a client bug;
  // neither is an intention worth serving silently.
  it.each([0, -1, 1.5, Number.NaN])('refuses %s as a bad request', (limit) => {
    let thrown: unknown;
    try {
      resolveConversationLimit(limit);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ProtocolError);
    expect((thrown as ProtocolError).code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('keeps the default no larger than the maximum', () => {
    expect(DEFAULT_CONVERSATION_LIMIT).toBeLessThanOrEqual(MAX_CONVERSATION_LIMIT);
  });
});
