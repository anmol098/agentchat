/**
 * The session shapes, and the two things about them that are decisions rather
 * than transcription.
 *
 * Register and end were moved out of `server/src/routes/sessions.ts` field for
 * field, so what they do is asserted by both sides of them compiling. The
 * listing is where a reasonable person would have written something else, and
 * those are the places a later edit will quietly "fix":
 *
 * - `includeEnded` accepts a boolean *and* a string, and treats every string
 *   but `"true"` as off rather than as an error;
 * - a summary carries `status`, not an `online` boolean, because telling
 *   `active` from `stale` is the entire point of the endpoint.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';

import { AgentId, ProjectId, SessionId } from '../ids.js';
import {
  ListSessionsQuerySchema,
  ListSessionsResponseSchema,
  RegisterSessionRequestSchema,
  SessionSummarySchema,
} from './sessions.js';

const PROJECT = ProjectId.generate();
const AGENT = AgentId.generate();
const SESSION = SessionId.generate();

/** A session exactly as `GET /sessions` renders one. */
const SUMMARY = {
  id: SESSION,
  agentId: AGENT,
  projectId: PROJECT,
  machineName: 'alices-mbp',
  runtime: 'claude-code',
  workingDirectory: '/Users/alice/src/payments',
  startedAt: '2026-09-09T12:00:00.000Z',
  lastSeenAt: '2026-09-09T12:34:56.789Z',
  endedAt: null,
  status: 'active',
};

describe('RegisterSessionRequestSchema', () => {
  it('refuses a registration with no runtime, because nothing may guess one (D14)', () => {
    const withoutRuntime = {
      agentId: AGENT,
      projectId: PROJECT,
      machine: { name: 'alices-mbp' },
      workingDirectory: '/Users/alice/src/payments',
    };

    expect(RegisterSessionRequestSchema.safeParse(withoutRuntime).success).toBe(false);
    expect(
      RegisterSessionRequestSchema.safeParse({ ...withoutRuntime, runtime: 'claude-code' }).success,
    ).toBe(true);
  });
});

describe('ListSessionsQuerySchema', () => {
  it('leaves both filters off when neither was given', () => {
    const parsed = ListSessionsQuerySchema.parse({});

    expect(parsed.projectId).toBeUndefined();
    expect(parsed.agentId).toBeUndefined();
    expect(parsed.includeEnded).toBe(false);
  });

  it('reads the exact string "true" from a query string', () => {
    // The server parses this schema against values Fastify pulled out of a URL,
    // where everything is a string.
    expect(ListSessionsQuerySchema.parse({ includeEnded: 'true' }).includeEnded).toBe(true);
  });

  it('reads the boolean a client passes', () => {
    expect(ListSessionsQuerySchema.parse({ includeEnded: true }).includeEnded).toBe(true);
    expect(ListSessionsQuerySchema.parse({ includeEnded: false }).includeEnded).toBe(false);
  });

  it('treats "false" as false, which a plain boolean coercion would not', () => {
    // `Boolean('false')` is `true`. This is the whole reason the field is not
    // `z.coerce.boolean()`, and it is the assertion that stops somebody making
    // it one.
    expect(ListSessionsQuerySchema.parse({ includeEnded: 'false' }).includeEnded).toBe(false);
  });

  it('declines to widen on an unrecognised value rather than failing the request', () => {
    // This endpoint is reached when something is already broken. A 400 over a
    // filter is a worse answer than the unfiltered listing.
    const parsed = ListSessionsQuerySchema.safeParse({ includeEnded: 'yes' });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.includeEnded).toBe(false);
  });

  it('refuses an identifier of the wrong kind, so a filter cannot silently miss', () => {
    expect(ListSessionsQuerySchema.safeParse({ agentId: PROJECT }).success).toBe(false);
  });
});

describe('SessionSummarySchema', () => {
  it('carries the lifecycle status rather than an online boolean', () => {
    // A stale session is not present and is still registered, which is exactly
    // the state somebody with a wedged listener is in. Collapsing it into
    // `online: false` would make the endpoint no more useful than the count it
    // replaced.
    expect(SessionSummarySchema.parse({ ...SUMMARY, status: 'stale' }).status).toBe('stale');
  });

  it('admits a null runtime, for a row this API did not write', () => {
    expect(SessionSummarySchema.parse({ ...SUMMARY, runtime: null }).runtime).toBeNull();
  });

  it('refuses a status outside the three the lifecycle has', () => {
    expect(SessionSummarySchema.safeParse({ ...SUMMARY, status: 'online' }).success).toBe(false);
  });
});

describe('ListSessionsResponseSchema', () => {
  it('is an envelope, so a cursor can be added without a major version (D17)', () => {
    expect(ListSessionsResponseSchema.parse({ items: [SUMMARY] }).items).toHaveLength(1);
    expect(ListSessionsResponseSchema.safeParse([SUMMARY]).success).toBe(false);
  });

  it('accepts an empty listing, which is what a stranger’s filter produces', () => {
    expect(ListSessionsResponseSchema.parse({ items: [] }).items).toEqual([]);
  });
});
