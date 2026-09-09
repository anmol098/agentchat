/**
 * `agentchat conversation`, spawned.
 *
 * The acceptance tests for the thread read. Both descriptors are captured
 * separately, as everywhere else in this directory, and the cases are about the
 * three things this command promises beyond "it prints messages":
 *
 * - **order and senders.** Oldest first, in the server's order, with
 *   `@user/agent` rather than `agt_…`.
 * - **paging.** A thread longer than a page is followed; a thread longer than
 *   the ceiling stops with a cursor and says so, on stderr, while stdout stays
 *   one parseable document.
 * - **no context needed.** The command runs with no project in the environment
 *   and no repository configuration, because a conversation identifier names
 *   its own project.
 *
 * @module
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Fixture, Prepared } from './messaging.js';
import {
  ALICE_BACKEND,
  baseRoutes,
  CONVERSATION,
  CONVERSATION_ID,
  MY_BACKEND,
  message,
  messageId,
  PROJECT_ID,
  runAgainst,
  startFixture,
} from './messaging.js';
import type { Run } from './spawn.js';
import { ANSI, buildPackage, parseNdjson, runCli } from './spawn.js';

let fixture: Fixture;

/** A thread of two messages, one each way, in one page. */
function thread(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation: CONVERSATION,
    messages: [
      message(1),
      message(2, { senderAgentId: MY_BACKEND, recipientAgentId: ALICE_BACKEND }),
    ],
    nextCursor: null,
    ...over,
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
  fixture.setRoutes(baseRoutes({ 'GET /conversations/:id': { status: 200, body: thread() } }));
});

/**
 * Runs `agentchat conversation …` against the stub.
 *
 * @param prepared - The home and working directory to run in.
 * @param argv - The arguments after `conversation`.
 * @returns Both streams and the exit code.
 */
function conversation(prepared: Prepared, argv: readonly string[]): Promise<Run> {
  return runAgainst(prepared, ['conversation', ...argv]);
}

/** Every `GET /conversations/:id` the stub saw. */
function reads(): { query: URLSearchParams }[] {
  return fixture.received.filter((entry) => entry.path.startsWith('/conversations/'));
}

describe('conversation --json', () => {
  it('puts one document on stdout with the thread in order and senders resolved', async () => {
    const run = await conversation(fixture.prepare(), [CONVERSATION_ID, '--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toMatch(ANSI);

    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toStrictEqual({
      conversation: {
        id: CONVERSATION_ID,
        projectId: PROJECT_ID,
        createdAt: CONVERSATION.createdAt,
      },
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
        {
          messageId: messageId(2),
          projectId: PROJECT_ID,
          conversationId: CONVERSATION_ID,
          parentMessageId: null,
          senderAgentId: MY_BACKEND,
          recipientAgentId: ALICE_BACKEND,
          sender: '@you/backend',
          recipient: '@alice/backend',
          content: 'message number 2',
          createdAt: '2026-09-09T12:02:00.000Z',
        },
      ],
      nextCursor: null,
      complete: true,
    });
  });

  it('emits the same message shape `inbox` does', async () => {
    fixture.setRoutes(
      baseRoutes({
        'GET /messages': { status: 200, body: { items: [message(1)], nextCursor: null } },
        'GET /conversations/:id': {
          status: 200,
          body: { conversation: CONVERSATION, messages: [message(1)], nextCursor: null },
        },
      }),
    );

    const prepared = fixture.prepare();
    const fromInbox = await runAgainst(prepared, ['inbox', '--json']);
    const fromThread = await conversation(prepared, [CONVERSATION_ID, '--json']);

    const inboxItem = (parseNdjson(fromInbox.stdout)[0] as { items: unknown[] }).items[0];
    const threadItem = (parseNdjson(fromThread.stdout)[0] as { items: unknown[] }).items[0];
    // The whole point of sharing `messageJson`: a harness parses one thing.
    expect(threadItem).toStrictEqual(inboxItem);
  });
});

describe('conversation in human mode', () => {
  it('prints the thread oldest first with each sender named', async () => {
    const run = await conversation(fixture.prepare(), [CONVERSATION_ID]);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout.indexOf('message number 1')).toBeLessThan(
      run.stdout.indexOf('message number 2'),
    );
    expect(run.stdout).toContain('@alice/backend');
    expect(run.stdout).toContain('@you/backend');
  });
});

describe('paging', () => {
  it('follows the cursor to the end of the thread', async () => {
    fixture.setRoutes(
      baseRoutes({
        'GET /conversations/:id': (received) =>
          received.query.get('after') === null
            ? {
                status: 200,
                body: {
                  conversation: CONVERSATION,
                  messages: [message(1)],
                  nextCursor: messageId(1),
                },
              }
            : {
                status: 200,
                body: { conversation: CONVERSATION, messages: [message(2)], nextCursor: null },
              },
      }),
    );

    const run = await conversation(fixture.prepare(), [CONVERSATION_ID, '--json']);

    expect(run.code).toBe(0);
    const [document] = parseNdjson(run.stdout) as [{ items: { messageId: string }[] }];
    expect(document.items.map((item) => item.messageId)).toStrictEqual([
      messageId(1),
      messageId(2),
    ]);
    expect(reads()).toHaveLength(2);
    expect(reads()[1]?.query.get('after')).toBe(messageId(1));
  });

  it('stops at the ceiling, reports the cursor, and warns on stderr only', async () => {
    let index = 0;
    fixture.setRoutes(
      baseRoutes({
        'GET /conversations/:id': () => {
          index += 1;
          return {
            status: 200,
            body: {
              conversation: CONVERSATION,
              messages: [message(index)],
              nextCursor: messageId(index),
            },
          };
        },
      }),
    );

    const run = await conversation(fixture.prepare(), [CONVERSATION_ID, '--json']);

    expect(run.code).toBe(0);
    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ complete: false, nextCursor: messageId(10) });
    expect(run.stderr).toContain('--after');
    // The warning went to the other descriptor, which is the contract.
    expect(run.stdout).not.toContain('--after');
  });
});

describe('failures', () => {
  it('refuses an argument that is not a conversation identifier, before any request', async () => {
    const run = await conversation(fixture.prepare(), ['msg_0199a1b2-c3d4-7e5f-8071-000000000001']);

    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('conversation identifier');
    expect(reads()).toHaveLength(0);
  });

  it('still prints the thread when the roster cannot be read, with identifiers instead', async () => {
    // No roster route at all: the addresses are decoration, and refusing to
    // print correspondence the server just handed over because the decoration
    // could not be fetched would be the wrong trade.
    fixture.setRoutes({ 'GET /conversations/:id': { status: 200, body: thread() } });

    const run = await conversation(fixture.prepare(), [CONVERSATION_ID, '--json']);

    expect(run.code).toBe(0);
    const [document] = parseNdjson(run.stdout) as [{ items: { sender: unknown }[] }];
    expect(document.items[0]).toMatchObject({ sender: null, senderAgentId: ALICE_BACKEND });
    expect(run.stderr).toContain('agent identifiers');
  });
});

describe('context', () => {
  it('reads a thread with no project in the environment and no repository config', async () => {
    const prepared = fixture.prepare();

    const run = await runCli(['conversation', CONVERSATION_ID, '--json'], {
      cwd: prepared.cwd,
      env: { HOME: prepared.home },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(parseNdjson(run.stdout)[0]).toMatchObject({
      conversation: { id: CONVERSATION_ID },
    });
  });
});
