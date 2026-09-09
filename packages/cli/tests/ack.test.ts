/**
 * `agentchat ack`, spawned.
 *
 * The acceptance tests for manual acknowledgement. The case that matters most
 * is the boring one: **a message that was already acknowledged is a success.**
 * D3 makes acknowledgement idempotent precisely so that a retry, a re-run, and
 * an acknowledgement racing a replay are all safe, and a harness that retries
 * hits that path constantly. A version of this command that reported it as a
 * failure would work in development and fail in every real deployment, so it is
 * pinned here in both representations and on the exit code.
 *
 * The other pinned contract is that one bad identifier does not cost the good
 * ones: every identifier is attempted, the document says what happened to each,
 * and only then does the run fail.
 *
 * @module
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Fixture, Prepared } from './messaging.js';
import {
  baseRoutes,
  MY_BACKEND,
  message,
  messageId,
  PROJECT_ID,
  runAgainst,
  SESSION_ID,
  startFixture,
} from './messaging.js';
import type { Run } from './spawn.js';
import { ANSI, buildPackage, parseNdjson } from './spawn.js';

let fixture: Fixture;

/**
 * The stub's answer to one acknowledgement.
 *
 * @param id - The message that was acknowledged.
 * @param already - Whether the debt had already been settled.
 * @returns The wire representation.
 */
function acknowledged(id: string, already = false): Record<string, unknown> {
  return {
    messageId: id,
    alreadyAcknowledged: already,
    acknowledgedAt: '2026-09-09T12:30:00.000Z',
    acknowledgedBySessionId: null,
  };
}

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
      'POST /messages/:id/ack': (received) => ({
        status: 200,
        body: acknowledged(received.path.split('/')[2] ?? ''),
      }),
    }),
  );
});

/**
 * Runs `agentchat ack …` against the stub.
 *
 * @param prepared - The home and working directory to run in.
 * @param argv - The arguments after `ack`.
 * @returns Both streams and the exit code.
 */
function ack(prepared: Prepared, argv: readonly string[]): Promise<Run> {
  return runAgainst(prepared, ['ack', ...argv]);
}

/** Every acknowledgement the stub received. */
function acks(): { path: string; body: Record<string, unknown> | null }[] {
  return fixture.received.filter((entry) => entry.path.endsWith('/ack'));
}

describe('ack --json', () => {
  it('puts one document on stdout, nothing on stderr, and exits 0', async () => {
    const run = await ack(fixture.prepare(), [messageId(1), '--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toMatch(ANSI);

    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toStrictEqual({
      projectId: PROJECT_ID,
      agent: { id: MY_BACKEND, address: '@you/backend' },
      items: [
        {
          messageId: messageId(1),
          acknowledged: true,
          alreadyAcknowledged: false,
          acknowledgedAt: '2026-09-09T12:30:00.000Z',
          acknowledgedBySessionId: null,
          error: null,
        },
      ],
      counts: { acknowledged: 1, alreadyAcknowledged: 0, failed: 0 },
    });
  });

  it('scopes the acknowledgement to the resolved agent and project', async () => {
    await ack(fixture.prepare(), [messageId(1), '--json']);

    expect(acks()).toHaveLength(1);
    expect(acks()[0]?.path).toBe(`/messages/${messageId(1)}/ack`);
    expect(acks()[0]?.body).toStrictEqual({ agentId: MY_BACKEND, projectId: PROJECT_ID });
  });

  it('forwards --session, which the server records and never consults', async () => {
    await ack(fixture.prepare(), [messageId(1), '--session', SESSION_ID, '--json']);

    expect(acks()[0]?.body).toMatchObject({ sessionId: SESSION_ID });
  });

  it('acknowledges several in the order they were given', async () => {
    const run = await ack(fixture.prepare(), [messageId(1), messageId(2), messageId(3), '--json']);

    expect(run.code).toBe(0);
    const [document] = parseNdjson(run.stdout) as [{ items: { messageId: string }[] }];
    expect(document.items.map((item) => item.messageId)).toStrictEqual([
      messageId(1),
      messageId(2),
      messageId(3),
    ]);
    expect(acks()).toHaveLength(3);
  });

  it('collapses a repeated identifier into one row and one request', async () => {
    const run = await ack(fixture.prepare(), [messageId(1), messageId(1), '--json']);

    expect(run.code).toBe(0);
    const [document] = parseNdjson(run.stdout) as [{ items: unknown[] }];
    expect(document.items).toHaveLength(1);
    expect(acks()).toHaveLength(1);
  });
});

describe('an acknowledgement that changed nothing', () => {
  it('is a success: exit 0, reported rather than raised', async () => {
    fixture.setRoutes(
      baseRoutes({
        'POST /messages/:id/ack': (received) => ({
          status: 200,
          body: acknowledged(received.path.split('/')[2] ?? '', true),
        }),
      }),
    );

    const run = await ack(fixture.prepare(), [messageId(1), '--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(parseNdjson(run.stdout)[0]).toMatchObject({
      items: [{ acknowledged: true, alreadyAcknowledged: true }],
      counts: { acknowledged: 1, alreadyAcknowledged: 1, failed: 0 },
    });
  });

  it('says so in the human rendering, on stdout, still with exit 0', async () => {
    fixture.setRoutes(
      baseRoutes({
        'POST /messages/:id/ack': (received) => ({
          status: 200,
          body: acknowledged(received.path.split('/')[2] ?? '', true),
        }),
      }),
    );

    const run = await ack(fixture.prepare(), [messageId(1)]);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('already');
  });
});

describe('failures', () => {
  it('attempts every identifier and reports the ones that worked', async () => {
    fixture.setRoutes(
      baseRoutes({
        'POST /messages/:id/ack': (received) => {
          const id = received.path.split('/')[2] ?? '';
          return id === messageId(2)
            ? {
                status: 404,
                body: { error: { code: 'NOT_FOUND', message: 'No such message.' } },
              }
            : { status: 200, body: acknowledged(id) };
        },
      }),
    );

    const run = await ack(fixture.prepare(), [messageId(1), messageId(2), messageId(3), '--json']);

    expect(run.code).not.toBe(0);
    // Three requests: the middle failure did not abandon the third identifier.
    expect(acks()).toHaveLength(3);

    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(2);
    expect(documents[0]).toMatchObject({
      items: [
        { messageId: messageId(1), acknowledged: true, error: null },
        { messageId: messageId(2), acknowledged: false, error: { code: 'NOT_FOUND' } },
        { messageId: messageId(3), acknowledged: true, error: null },
      ],
      counts: { acknowledged: 2, alreadyAcknowledged: 0, failed: 1 },
    });
    // The receipt first, then the failure. The run failed; two messages are
    // still acknowledged and the document is what says which.
    expect(documents[1]).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });

  it('refuses a malformed identifier before acknowledging anything', async () => {
    const run = await ack(fixture.prepare(), [messageId(1), 'not-a-message-id']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('message identifier');
    expect(acks()).toHaveLength(0);
  });

  it('needs at least one identifier', async () => {
    const run = await ack(fixture.prepare(), []);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(acks()).toHaveLength(0);
  });
});

describe('the loop `inbox` and `ack` close', () => {
  it('acknowledges exactly the identifiers the inbox reported', async () => {
    fixture.setRoutes(
      baseRoutes({
        'GET /messages': {
          status: 200,
          body: { items: [message(1), message(2)], nextCursor: null },
        },
        'POST /messages/:id/ack': (received) => ({
          status: 200,
          body: acknowledged(received.path.split('/')[2] ?? ''),
        }),
      }),
    );

    const prepared = fixture.prepare();
    const listed = await runAgainst(prepared, ['inbox', '--json']);
    const ids = (parseNdjson(listed.stdout)[0] as { items: { messageId: string }[] }).items.map(
      (item) => item.messageId,
    );

    const run = await ack(prepared, [...ids, '--json']);

    expect(run.code).toBe(0);
    expect(acks().map((entry) => entry.path)).toStrictEqual([
      `/messages/${messageId(1)}/ack`,
      `/messages/${messageId(2)}/ack`,
    ]);
  });
});
