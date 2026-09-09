/**
 * `agentchat inbox`, spawned.
 *
 * The acceptance tests for the polling half of T-313. Like the rest of this
 * directory they start a real process against a real socket and read file
 * descriptor 1 and file descriptor 2 **separately** (`./spawn.ts`), because
 * this is a command an AI harness parses rather than reads: one stray log line
 * on stdout corrupts its input, and a suite that merged the descriptors would
 * pass while PRD §39 was broken.
 *
 * Three things here are contracts rather than behaviour, and each has a case
 * whose failure means the contract moved:
 *
 * - the `--json` document, field for field, including `items` when it is empty;
 * - that a queue longer than one page is followed and, past the ceiling,
 *   reported with a cursor rather than truncated in silence;
 * - that `--all` asks the server and surfaces its refusal, rather than quietly
 *   showing the pending queue instead.
 *
 * @module
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Fixture, Prepared } from './messaging.js';
import {
  ALICE_BACKEND,
  baseRoutes,
  CONVERSATION_ID,
  GHOST_AGENT,
  MY_BACKEND,
  message,
  messageId,
  PROJECT_ID,
  runAgainst,
  startFixture,
} from './messaging.js';
import type { Run } from './spawn.js';
import { ANSI, buildPackage, parseNdjson } from './spawn.js';

let fixture: Fixture;

beforeAll(async () => {
  await buildPackage();
  fixture = await startFixture();
}, 180_000);

afterAll(async () => {
  await fixture.close();
});

beforeEach(() => {
  fixture.setRoutes(
    baseRoutes({
      'GET /messages': { status: 200, body: { items: [message(1)], nextCursor: null } },
    }),
  );
});

/**
 * Runs `agentchat inbox …` against the stub.
 *
 * @param prepared - The home and working directory to run in.
 * @param argv - The arguments after `inbox`.
 * @returns Both streams and the exit code.
 */
function inbox(prepared: Prepared, argv: readonly string[] = []): Promise<Run> {
  return runAgainst(prepared, ['inbox', ...argv]);
}

/** Every `GET /messages` the stub saw. */
function listings(): { query: URLSearchParams }[] {
  return fixture.received.filter((entry) => entry.path === '/messages');
}

describe('inbox --json', () => {
  it('puts one document on stdout, nothing on stderr, and no colour on a pipe', async () => {
    const run = await inbox(fixture.prepare(), ['--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toMatch(ANSI);

    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toStrictEqual({
      projectId: PROJECT_ID,
      agent: { id: MY_BACKEND, address: '@you/backend' },
      status: 'pending',
      items: [
        {
          messageId: messageId(1),
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          parentMessageId: null,
          senderAgentId: ALICE_BACKEND,
          recipientAgentId: MY_BACKEND,
          sender: '@alice/backend',
          recipient: '@you/backend',
          content: 'message number 1',
          createdAt: '2026-09-09T12:01:00.000Z',
        },
      ],
      nextCursor: null,
      complete: true,
    });
  });

  it('asks for the pending queue of the resolved agent in the resolved project', async () => {
    await inbox(fixture.prepare(), ['--json']);

    const [listing] = listings();
    expect(listing?.query.get('projectId')).toBe(PROJECT_ID);
    expect(listing?.query.get('agentId')).toBe(MY_BACKEND);
    expect(listing?.query.get('status')).toBe('pending');
  });

  it('emits a document with an empty items array when nothing is pending', async () => {
    fixture.setRoutes(
      baseRoutes({ 'GET /messages': { status: 200, body: { items: [], nextCursor: null } } }),
    );

    const run = await inbox(fixture.prepare(), ['--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    // Not empty output. A consumer must be able to tell "nothing pending" from
    // "the command did not run" without inspecting the exit code.
    expect(parseNdjson(run.stdout)[0]).toMatchObject({ items: [], complete: true });
  });

  it('reports an address of null for a sender the roster no longer names', async () => {
    fixture.setRoutes(
      baseRoutes({
        'GET /messages': {
          status: 200,
          body: { items: [message(1, { senderAgentId: GHOST_AGENT })], nextCursor: null },
        },
      }),
    );

    const run = await inbox(fixture.prepare(), ['--json']);

    expect(run.code).toBe(0);
    const [document] = parseNdjson(run.stdout) as [{ items: { sender: unknown }[] }];
    expect(document.items[0]).toMatchObject({ sender: null, senderAgentId: GHOST_AGENT });
  });
});

/**
 * Every field the live delivery puts in a `message` frame, as `MessageEnvelope`
 * in `server/src/routing/delivery.ts` declares them (Plan §4.2).
 *
 * Copied rather than imported, and that is not laziness: `packages/` is MIT and
 * `server/` is AGPL, so the import that would keep these two in step is the one
 * dependency this repository forbids. A literal list with the source named is
 * the strongest link the licence boundary permits, and the assertion below is
 * what makes it more than a comment.
 */
const DELIVERED_FIELDS = [
  'messageId',
  'projectId',
  'conversationId',
  'parentMessageId',
  'senderAgentId',
  'sender',
  'recipientAgentId',
  'content',
  'createdAt',
] as const;

describe('the shape a harness parses', () => {
  /**
   * The criterion is that a harness parses one message shape, not two: what
   * `agentchat listen` streams and what this command polls have to agree.
   *
   * They agree by containment rather than by identity, and the difference is
   * worth stating because it was not the plan. `listen` (T-312) passes the
   * server's envelope through verbatim so that a field a newer server adds
   * reaches a consumer without a CLI release — a good decision for a stream,
   * and one that means it does not call this command's renderer. So the
   * property to hold is the one that actually serves a caller: **every field
   * the listener emits is here, under the same name.** A parser written against
   * the stream reads a polled item unchanged.
   *
   * The three deliberate differences, none of which breaks that parser:
   *
   * - `recipient` is extra. The listener has no need of it — a delivery goes to
   *   the socket that is the recipient — and a reader that has just polled its
   *   own queue is in the same position, but a thread read out of
   *   `agentchat conversation` is not, and one message shape means the field is
   *   present in all three.
   * - An unresolved `sender` is `null` here and *absent* there. Plan §12.4
   *   makes an omitted field the additive-safe choice on a wire; a document
   *   whose keys came and went would make `items` awkward to consume as a
   *   table. `?? fallback` reads both.
   * - `parentMessageId` is the same story. It is `null` here for a thread root
   *   and *absent* there, for the same reason and read the same way. It was
   *   missing from this list, which is how the claim that these two shapes
   *   match reached `docs/cli.md`, both help texts and the README before
   *   T-046 and T-056 unpicked it.
   */
  it('carries every field the listener streams, under the same names', async () => {
    const run = await inbox(fixture.prepare(), ['--json']);

    const [document] = parseNdjson(run.stdout) as [{ items: Record<string, unknown>[] }];
    const item = document.items[0] ?? {};

    for (const field of DELIVERED_FIELDS) {
      expect(Object.keys(item)).toContain(field);
    }
    // Containment, stated in the other direction too, so that a field added
    // here has to be added to this list — and to `agentchat listen` — rather
    // than quietly making the two shapes diverge.
    expect(Object.keys(item).toSorted()).toStrictEqual(
      [...DELIVERED_FIELDS, 'recipient'].toSorted(),
    );
  });
});

describe('inbox in human mode', () => {
  it('writes the message block to stdout and keeps stderr clean', async () => {
    const run = await inbox(fixture.prepare());

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('[agentchat message]');
    expect(run.stdout).toContain('@alice/backend');
    expect(run.stdout).toContain('message number 1');
    // The handoff: what to type next to clear it.
    expect(run.stdout).toContain(`agentchat ack ${messageId(1)}`);
  });

  it('says so in words when there is nothing pending, and still exits 0', async () => {
    fixture.setRoutes(
      baseRoutes({ 'GET /messages': { status: 200, body: { items: [], nextCursor: null } } }),
    );

    const run = await inbox(fixture.prepare());

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('Nothing pending');
    expect(run.stderr).toBe('');
  });
});

describe('paging', () => {
  it('follows the cursor across pages and returns one merged listing', async () => {
    fixture.setRoutes(
      baseRoutes({
        'GET /messages': (received) =>
          received.query.get('after') === null
            ? { status: 200, body: { items: [message(1)], nextCursor: messageId(1) } }
            : { status: 200, body: { items: [message(2)], nextCursor: null } },
      }),
    );

    const run = await inbox(fixture.prepare(), ['--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    const [document] = parseNdjson(run.stdout) as [{ items: { messageId: string }[] }];
    expect(document.items.map((item) => item.messageId)).toStrictEqual([
      messageId(1),
      messageId(2),
    ]);
    expect(document).toMatchObject({ nextCursor: null, complete: true });

    expect(listings()).toHaveLength(2);
    expect(listings()[1]?.query.get('after')).toBe(messageId(1));
  });

  it('stops at the ceiling and reports a cursor rather than truncating in silence', async () => {
    // A queue that never ends: every page carries a cursor.
    let index = 0;
    fixture.setRoutes(
      baseRoutes({
        'GET /messages': () => {
          index += 1;
          return {
            status: 200,
            body: { items: [message(index)], nextCursor: messageId(index) },
          };
        },
      }),
    );

    const run = await inbox(fixture.prepare(), ['--json']);

    expect(run.code).toBe(0);
    const [document] = parseNdjson(run.stdout) as [
      { items: unknown[]; complete: boolean; nextCursor: string },
    ];
    expect(document.complete).toBe(false);
    expect(document.nextCursor).toBe(messageId(document.items.length));
    // Ten pages, and the truncation announced on stderr where it cannot corrupt
    // the document on stdout.
    expect(document.items).toHaveLength(10);
    expect(run.stderr).toContain('--after');
  });

  it('resumes from --after on the first request', async () => {
    await inbox(fixture.prepare(), ['--json', '--after', messageId(4)]);

    expect(listings()[0]?.query.get('after')).toBe(messageId(4));
  });

  it('refuses an --after that is not a message identifier, before any request', async () => {
    const run = await inbox(fixture.prepare(), ['--after', 'cnv_not-a-message']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('message identifier');
    expect(listings()).toHaveLength(0);
  });
});

describe('--all', () => {
  it('asks the server for the historical listing', async () => {
    fixture.setRoutes(
      baseRoutes({
        'GET /messages': { status: 200, body: { items: [message(1)], nextCursor: null } },
      }),
    );

    const run = await inbox(fixture.prepare(), ['--all', '--json']);

    expect(run.code).toBe(0);
    expect(listings()[0]?.query.get('status')).toBe('all');
    expect(parseNdjson(run.stdout)[0]).toMatchObject({ status: 'all' });
  });

  it('surfaces the refusal instead of quietly showing the pending queue', async () => {
    fixture.setRoutes(
      baseRoutes({
        'GET /messages': {
          status: 400,
          body: {
            error: {
              code: 'BAD_REQUEST',
              message:
                'This server answers status=pending only; the historical listing (status=all, since) is not implemented yet.',
            },
          },
        },
      }),
    );

    const run = await inbox(fixture.prepare(), ['--all']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('historical listing');
    // The remedy, not just the complaint.
    expect(run.stderr).toContain('agentchat inbox');
  });

  it('keeps stdout parseable when the refusal happens in --json mode', async () => {
    fixture.setRoutes(
      baseRoutes({
        'GET /messages': {
          status: 400,
          body: { error: { code: 'BAD_REQUEST', message: 'not implemented yet.' } },
        },
      }),
    );

    const run = await inbox(fixture.prepare(), ['--all', '--json']);

    expect(run.code).toBe(2);
    expect(run.stdout).not.toMatch(ANSI);
    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });
});
