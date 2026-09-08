/**
 * `agentchat send`, driven in process against a stubbed server.
 *
 * The suite under `../../tests/send.test.ts` spawns the real binary and is what
 * proves the stream contract and the real pipe. This one covers the branches a
 * subprocess test would pay a process launch each to reach, and two claims that
 * are otherwise easy to break silently:
 *
 * - **A retry reuses the idempotency key.** The transport records every call,
 *   and the retry cases assert that the `clientMessageId` on attempt two is the
 *   same string as on attempt one. Mint the key inside the retry loop and these
 *   fail; leave it outside and they pass. Nothing else in the suite would
 *   notice.
 * - **The body is not touched.** Every body fixture carries something a
 *   well-meaning helper would tidy — a trailing newline, a CRLF, leading
 *   spaces, a multi-byte character split across two chunks — and the assertions
 *   demand it back byte for byte.
 *
 * @module
 */

import type { Transport, TransportRequest, TransportResponse } from '@agentchat/client';
import { InMemoryCredentialStore, TransportError } from '@agentchat/client';
import {
  AgentId,
  ConversationId,
  ErrorCode,
  errorEnvelope,
  MessageId,
  ProjectId,
  UserId,
} from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import type { InputStream } from '../output/streams.js';
import { captureRun } from '../testing.js';
import type { SendOverrides } from './send.js';
import { createSendCommand, parseRecipient } from './send.js';

const SERVER = 'https://chat.example.test';

const PROJECT = ProjectId.generate();
const ME = UserId.generate();
const ALICE = UserId.generate();

const MY_BACKEND = AgentId.generate();
const ALICE_BACKEND = AgentId.generate();
const ALICE_FRONTEND = AgentId.generate();

const MESSAGE = MessageId.generate();
const CONVERSATION = ConversationId.generate();
const PARENT = MessageId.generate();
const OTHER_CONVERSATION = ConversationId.generate();

const SEND = 'POST /messages';
const ROSTER = `GET /projects/${PROJECT}/agents`;
const WHOAMI = 'GET /me';
const LIST_PROJECTS = 'GET /projects';

/** The account the fixtures run as. */
const USER = {
  id: ME,
  username: 'you',
  displayName: 'You Example',
  email: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

/**
 * One row of the project's agent roster.
 *
 * @param id - The agent's id.
 * @param name - The agent's name.
 * @param owner - Who owns it: the account id and its username.
 * @returns The wire representation.
 */
function row(
  id: string,
  name: string,
  owner: { id: string; username: string },
): Record<string, unknown> {
  return {
    agent: {
      id,
      userId: owner.id,
      name,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    owner: { ...owner, displayName: `${owner.username} Example` },
    online: true,
    sessions: 1,
  };
}

/** The roster every fixture sends into: one of mine, two of Alice's. */
const LISTING = [
  row(ALICE_BACKEND, 'backend', { id: ALICE, username: 'alice' }),
  row(ALICE_FRONTEND, 'frontend', { id: ALICE, username: 'alice' }),
  row(MY_BACKEND, 'backend', { id: ME, username: 'you' }),
];

/**
 * The message the stub commits.
 *
 * @param over - Fields to vary.
 * @returns The wire representation.
 */
function committed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MESSAGE,
    projectId: PROJECT,
    conversationId: CONVERSATION,
    parentMessageId: null,
    senderAgentId: MY_BACKEND,
    recipientAgentId: ALICE_BACKEND,
    content: 'ignored by this command',
    createdAt: '2026-09-08T12:00:00.000Z',
    ...over,
  };
}

/** One scripted answer. */
interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

/** A transport that answers from a script instead of a socket. */
class StubServer implements Transport {
  public readonly calls: TransportRequest[] = [];
  readonly #replies = new Map<string, Reply>();
  #failuresLeft = 0;

  public on(key: string, reply: Reply): this {
    this.#replies.set(key, reply);
    return this;
  }

  /** Makes the next `count` sends fail as though the connection dropped. */
  public failSends(count: number): this {
    this.#failuresLeft = count;
    return this;
  }

  public get keys(): readonly string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  public countOf(key: string): number {
    return this.keys.filter((seen) => seen === key).length;
  }

  /** Every body posted to `POST /messages`, in order. */
  public get sends(): readonly Record<string, unknown>[] {
    return this.calls
      .filter((call) => call.method === 'POST' && call.path === '/messages')
      .map((call) => call.body as Record<string, unknown>);
  }

  public request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    const key = `${request.method} ${request.path}`;
    if (key === SEND && this.#failuresLeft > 0) {
      this.#failuresLeft -= 1;
      // What a dropped connection looks like: no response at all, so the caller
      // cannot know whether the message was committed.
      return Promise.reject(new TransportError('socket hang up'));
    }
    const reply = this.#replies.get(key);
    if (reply === undefined) {
      return Promise.resolve({
        status: 404,
        headers: {},
        body: errorEnvelope(ErrorCode.NOT_FOUND, `No stub for ${key}.`),
      });
    }
    return Promise.resolve({ status: reply.status, headers: {}, body: reply.body ?? {} });
  }
}

/**
 * A stub answering the roster, the account, and a successful send.
 *
 * @param items - The roster rows. Defaults to {@link LISTING}.
 * @returns The stub.
 */
function stubWith(items: readonly Record<string, unknown>[] = LISTING): StubServer {
  return new StubServer()
    .on(ROSTER, { status: 200, body: { items } })
    .on(WHOAMI, { status: 200, body: USER })
    .on(SEND, { status: 201, body: committed() });
}

/** A store that is logged in, so authenticated calls reach the transport. */
function signedIn(): InMemoryCredentialStore {
  return new InMemoryCredentialStore({ accessToken: 'access', refreshToken: 'refresh' });
}

/**
 * A descriptor that produces a fixed sequence of byte chunks and remembers
 * whether anybody asked for them.
 *
 * The `read` flag is what makes "an unknown recipient does not consume standard
 * input" a real assertion rather than a restatement of "nothing was sent".
 */
class ChunkedInput implements InputStream {
  readonly #chunks: readonly Uint8Array[];

  /** Whether the descriptor was iterated at all. */
  public read = false;

  public constructor(chunks: readonly Uint8Array[]) {
    this.#chunks = chunks;
  }

  public async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    this.read = true;
    for (const chunk of this.#chunks) {
      await Promise.resolve();
      yield chunk;
    }
  }
}

/**
 * A recording descriptor over a string.
 *
 * @param text - What it produces, as one chunk.
 * @returns The descriptor.
 */
function inputOf(text: string): ChunkedInput {
  return new ChunkedInput([new TextEncoder().encode(text)]);
}

/** What one in-process invocation produced. */
interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** How to run one case. */
interface RunOptions {
  readonly overrides?: SendOverrides;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: string | InputStream;
}

/**
 * Runs `agentchat send` through the whole framework.
 *
 * The retry delay is stubbed out so a case that proves the retry reuses its key
 * does not also spend a second and a quarter waiting.
 *
 * @param argv - The arguments after `send`.
 * @param options - Seams, environment, and standard input.
 * @returns Both streams and the exit code.
 */
async function runSend(argv: readonly string[], options: RunOptions = {}): Promise<Outcome> {
  // `--server` goes before the arguments, not after: a case that puts a body
  // behind `--` would otherwise swallow the flag as a third positional.
  return await captureRun(['send', '--server', SERVER, ...argv], {
    commands: [
      createSendCommand({
        store: signedIn(),
        sleep: () => Promise.resolve(),
        ...options.overrides,
      }),
    ],
    env: { XDG_CONFIG_HOME: '/nonexistent', AGENTCHAT_PROJECT: PROJECT, ...options.env },
    cwd: '/tmp',
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
  });
}

/**
 * The one JSON document a run put on stdout.
 *
 * @param outcome - The run.
 * @returns The parsed document.
 */
function documentOf(outcome: Outcome): Record<string, unknown> {
  const lines = outcome.stdout.trimEnd().split('\n');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? '') as Record<string, unknown>;
}

describe('the argument form', () => {
  it('resolves the project and the sender from context and posts the message', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', 'the build is green', '--json'], {
      overrides: { transport },
    });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(transport.sends).toHaveLength(1);
    expect(transport.sends[0]).toMatchObject({
      projectId: PROJECT,
      // Nobody named an agent: `you` has exactly one in this project, and the
      // roster the recipient was looked up in is what made that answerable.
      senderAgentId: MY_BACKEND,
      recipientAgentId: ALICE_BACKEND,
      content: 'the build is green',
    });
    expect(transport.sends[0]?.['conversationId']).toBeUndefined();
    expect(transport.sends[0]?.['parentMessageId']).toBeUndefined();
  });

  it('emits a flat document whose message and conversation are at the top level', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', 'hello', '--json'], { overrides: { transport } });

    const document = documentOf(run);
    expect(document).toStrictEqual({
      messageId: MESSAGE,
      conversationId: CONVERSATION,
      parentMessageId: null,
      projectId: PROJECT,
      clientMessageId: expect.any(String),
      duplicate: false,
      createdAt: '2026-09-08T12:00:00.000Z',
      contentBytes: 5,
      sender: { address: '@you/backend', agentId: MY_BACKEND },
      recipient: { address: '@alice/backend', agentId: ALICE_BACKEND },
    });
    // The content is deliberately not echoed back; see the module note.
    expect(document['content']).toBeUndefined();
  });

  it('reads the project and the roster once each, and sends once', async () => {
    const transport = stubWith();

    await runSend(['@alice/backend', 'hello', '--json'], { overrides: { transport } });

    expect(transport.countOf(ROSTER)).toBe(1);
    expect(transport.countOf(WHOAMI)).toBe(1);
    expect(transport.countOf(SEND)).toBe(1);
    // The project came from the environment as an id, so nothing had to turn a
    // slug into one.
    expect(transport.countOf(LIST_PROJECTS)).toBe(0);
  });

  it('turns a project slug into an identifier, and only then', async () => {
    const transport = stubWith().on(LIST_PROJECTS, {
      status: 200,
      body: {
        items: [
          {
            id: PROJECT,
            slug: 'payments',
            name: 'Payments Platform',
            createdBy: ME,
            createdAt: '2026-01-01T00:00:00.000Z',
            role: 'member',
          },
        ],
      },
    });

    const run = await runSend(['@alice/backend', 'hello', '--json'], {
      overrides: { transport },
      env: { AGENTCHAT_PROJECT: 'payments' },
    });

    expect(run.code).toBe(0);
    expect(transport.countOf(LIST_PROJECTS)).toBe(1);
  });

  it('renders a receipt a person can read, with nothing on stderr', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', 'hello'], { overrides: { transport } });

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain('Sent to @alice/backend');
    expect(run.stdout).toContain(MESSAGE);
    expect(run.stdout).toContain(CONVERSATION);
    expect(run.stdout).toContain('@you/backend');
  });
});

describe('the standard input form', () => {
  it('sends the whole body verbatim, keeping the trailing newline', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', '-', '--json'], {
      overrides: { transport },
      stdin: '  line one\r\nline two\n',
    });

    expect(run.code).toBe(0);
    // Not trimmed, not folded, not stripped. A generated document arrives as it
    // was produced.
    expect(transport.sends[0]?.['content']).toBe('  line one\r\nline two\n');
  });

  it('reassembles a multi-byte character split across two chunks', async () => {
    const transport = stubWith();
    const bytes = new TextEncoder().encode('héllo — ok');

    const run = await runSend(['@alice/backend', '-', '--json'], {
      overrides: { transport },
      // Split inside the two-byte `é`, which is what a real pipe does.
      stdin: new ChunkedInput([bytes.slice(0, 2), bytes.slice(2)]),
    });

    expect(run.code).toBe(0);
    expect(transport.sends[0]?.['content']).toBe('héllo — ok');
    expect(documentOf(run)['contentBytes']).toBe(bytes.length);
  });

  it('sends text that begins with a hyphen when it is put after `--`', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', '--', '--json'], { overrides: { transport } });

    expect(run.code).toBe(0);
    // `--json` after `--` is the message, not a flag: stdout is the human
    // receipt rather than a JSON document.
    expect(transport.sends[0]?.['content']).toBe('--json');
    expect(run.stdout).toContain('Sent to @alice/backend');
  });

  it('carries a body far larger than an argument list would take', async () => {
    const transport = stubWith();
    const body = 'x'.repeat(600_000);

    const run = await runSend(['@alice/backend', '-', '--json'], {
      overrides: { transport },
      stdin: body,
    });

    expect(run.code).toBe(0);
    expect(transport.sends[0]?.['content']).toBe(body);
    expect(documentOf(run)['contentBytes']).toBe(600_000);
  });

  it('refuses a body over the limit rather than truncating it, and sends nothing', async () => {
    const transport = stubWith();
    const oversized = 'x'.repeat(1_048_577);

    const run = await runSend(['@alice/backend', '-'], {
      overrides: { transport },
      stdin: oversized,
    });

    expect(run.code).not.toBe(0);
    // The real size and the amount to cut, so the caller can act without
    // measuring UTF-8 themselves.
    expect(run.stderr).toContain('1,048,577 bytes');
    expect(run.stderr).toContain('Cut 1 bytes');
    expect(transport.countOf(SEND)).toBe(0);
  });

  it('warns on stderr when standard input was empty, and still sends', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', '-'], { overrides: { transport }, stdin: '' });

    expect(run.code).toBe(0);
    expect(run.stderr).toContain('Standard input was empty');
    expect(transport.sends[0]?.['content']).toBe('');
  });
});

describe('threading', () => {
  it('sends into an existing conversation', async () => {
    const transport = stubWith().on(SEND, {
      status: 201,
      body: committed({ conversationId: OTHER_CONVERSATION }),
    });

    const run = await runSend(
      ['@alice/backend', 'still here', '--conversation', OTHER_CONVERSATION, '--json'],
      { overrides: { transport } },
    );

    expect(run.code).toBe(0);
    expect(transport.sends[0]).toMatchObject({ conversationId: OTHER_CONVERSATION });
    expect(documentOf(run)['conversationId']).toBe(OTHER_CONVERSATION);
  });

  it('sends a reply, and reports the conversation the server inherited for it', async () => {
    const transport = stubWith().on(SEND, {
      status: 201,
      body: committed({ conversationId: OTHER_CONVERSATION, parentMessageId: PARENT }),
    });

    const run = await runSend(['@alice/backend', 'on it', '--reply-to', PARENT, '--json'], {
      overrides: { transport },
    });

    expect(run.code).toBe(0);
    // The client never guesses the conversation for a reply. It sends the
    // parent, and reports whatever conversation the server said the reply
    // belongs to.
    expect(transport.sends[0]).toMatchObject({ parentMessageId: PARENT });
    expect(transport.sends[0]?.['conversationId']).toBeUndefined();
    expect(documentOf(run)).toMatchObject({
      parentMessageId: PARENT,
      conversationId: OTHER_CONVERSATION,
    });
  });

  it('passes both through when both were given, and lets the server judge them', async () => {
    const transport = stubWith();

    await runSend(
      ['@alice/backend', 'hi', '--reply-to', PARENT, '--conversation', CONVERSATION, '--json'],
      { overrides: { transport } },
    );

    expect(transport.sends[0]).toMatchObject({
      parentMessageId: PARENT,
      conversationId: CONVERSATION,
    });
  });

  it('surfaces the server refusing a parent and a conversation that disagree', async () => {
    const transport = stubWith().on(SEND, {
      status: 400,
      body: errorEnvelope(
        ErrorCode.BAD_REQUEST,
        'parentMessageId and conversationId disagree; a reply belongs to its parent conversation.',
      ),
    });

    const run = await runSend(
      ['@alice/backend', 'hi', '--reply-to', PARENT, '--conversation', CONVERSATION],
      { overrides: { transport } },
    );

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('disagree');
  });

  it('rejects a threading option that is not an identifier of the right kind', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', 'hi', '--reply-to', CONVERSATION], {
      overrides: { transport },
    });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('msg_');
    expect(transport.countOf(SEND)).toBe(0);
  });
});

describe('the idempotency key', () => {
  it('reuses the same key on a retry after the response was never seen', async () => {
    const transport = stubWith().failSends(1);

    const run = await runSend(['@alice/backend', 'the build is green', '--json'], {
      overrides: { transport },
    });

    expect(run.code).toBe(0);
    expect(transport.countOf(SEND)).toBe(2);
    // The whole point. A key minted per attempt would let the second attempt
    // write a second message when the first had in fact committed.
    const [first, second] = transport.sends;
    expect(first?.['clientMessageId']).toBe(second?.['clientMessageId']);
    expect(documentOf(run)['clientMessageId']).toBe(first?.['clientMessageId']);
    expect(run.stderr).toContain('retrying under the same client message id');
  });

  it('gives up after three attempts and says the server was not reached', async () => {
    const transport = stubWith().failSends(5);

    const run = await runSend(['@alice/backend', 'hello'], { overrides: { transport } });

    expect(run.code).not.toBe(0);
    expect(transport.countOf(SEND)).toBe(3);
    expect(new Set(transport.sends.map((body) => body['clientMessageId'])).size).toBe(1);
  });

  it('does not retry an answer, however unwelcome', async () => {
    const transport = stubWith().on(SEND, {
      status: 503,
      body: errorEnvelope(ErrorCode.INTERNAL, 'Service unavailable.'),
    });

    const run = await runSend(['@alice/backend', 'hello'], { overrides: { transport } });

    expect(run.code).not.toBe(0);
    expect(transport.countOf(SEND)).toBe(1);
  });

  it('sends under a key the caller supplied, so a re-run cannot duplicate', async () => {
    const transport = stubWith();

    const run = await runSend(
      ['@alice/backend', 'hello', '--client-message-id', 'release-2026-09-08', '--json'],
      { overrides: { transport } },
    );

    expect(transport.sends[0]?.['clientMessageId']).toBe('release-2026-09-08');
    expect(documentOf(run)['clientMessageId']).toBe('release-2026-09-08');
  });

  it('refuses a key the server could not store', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', 'hi', '--client-message-id', 'k'.repeat(201)], {
      overrides: { transport },
    });

    expect(run.code).toBe(2);
    expect(transport.countOf(SEND)).toBe(0);
  });

  it('mints a fresh key per invocation', async () => {
    const transport = stubWith();

    await runSend(['@alice/backend', 'one', '--json'], { overrides: { transport } });
    await runSend(['@alice/backend', 'two', '--json'], { overrides: { transport } });

    expect(transport.sends[0]?.['clientMessageId']).not.toBe(
      transport.sends[1]?.['clientMessageId'],
    );
  });
});

describe('a duplicate send', () => {
  it('is a success, and says so rather than hiding it', async () => {
    const transport = stubWith().on(SEND, { status: 200, body: committed() });

    const run = await runSend(['@alice/backend', 'hello', '--json'], { overrides: { transport } });

    expect(run.code).toBe(0);
    expect(documentOf(run)).toMatchObject({ duplicate: true, messageId: MESSAGE });
  });

  it('explains itself in the human rendering, on stdout with the rest of the receipt', async () => {
    const transport = stubWith().on(SEND, { status: 200, body: committed() });

    const run = await runSend(['@alice/backend', 'hello'], { overrides: { transport } });

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('had already been sent');
    expect(run.stderr).toBe('');
  });
});

describe('an unknown recipient', () => {
  it('names the discovery command rather than reporting a raw failure', async () => {
    const transport = stubWith();

    const run = await runSend(['@carol/backend', 'hello'], { overrides: { transport } });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('agentchat agents');
    expect(transport.countOf(SEND)).toBe(0);
  });

  it("lists that owner's agents when the person exists but the agent does not", async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/api', 'hello'], { overrides: { transport } });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('@alice/backend');
    expect(run.stderr).toContain('@alice/frontend');
  });

  it('refuses an address that is not one, before opening a connection', async () => {
    const transport = stubWith();

    const run = await runSend(['alice/backend', 'hello'], { overrides: { transport } });

    expect(run.code).toBe(2);
    expect(run.stderr).toContain('@user/agent');
    expect(transport.calls).toHaveLength(0);
  });

  it('accepts a bare agent id, which is what `agents --json` emits', async () => {
    const transport = stubWith();

    const run = await runSend([ALICE_FRONTEND, 'hello', '--json'], { overrides: { transport } });

    expect(run.code).toBe(0);
    expect(transport.sends[0]).toMatchObject({ recipientAgentId: ALICE_FRONTEND });
  });

  it('does not read standard input when the recipient is unknown', async () => {
    const transport = stubWith();
    const stdin = inputOf('a body nobody should have to produce');

    const run = await runSend(['@carol/backend', '-'], { overrides: { transport }, stdin });

    expect(run.code).not.toBe(0);
    expect(transport.countOf(SEND)).toBe(0);
    // The producer is never asked for a byte, which is why the body is read
    // after the roster rather than before it.
    expect(stdin.read).toBe(false);
  });
});

describe('the sender', () => {
  it('acts as the agent `--agent` names', async () => {
    const transport = stubWith([
      ...LISTING,
      row(AgentId.generate(), 'docs', { id: ME, username: 'you' }),
    ]);

    const run = await runSend(['@alice/backend', 'hello', '--agent', 'backend', '--json'], {
      overrides: { transport },
    });

    expect(run.code).toBe(0);
    expect(transport.sends[0]).toMatchObject({ senderAgentId: MY_BACKEND });
  });

  it('refuses an agent of yours that is not in this project', async () => {
    const transport = stubWith();

    const run = await runSend(['@alice/backend', 'hello', '--agent', 'docs'], {
      overrides: { transport },
    });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('agent join docs');
    expect(transport.countOf(SEND)).toBe(0);
  });

  it('will not guess when you have several agents here', async () => {
    const transport = stubWith([
      ...LISTING,
      row(AgentId.generate(), 'docs', { id: ME, username: 'you' }),
    ]);

    const run = await runSend(['@alice/backend', 'hello'], { overrides: { transport } });

    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain('agent use');
    expect(transport.countOf(SEND)).toBe(0);
  });
});

describe('parseRecipient', () => {
  it('reads a handle', () => {
    expect(parseRecipient('@alice/backend')).toStrictEqual({
      kind: 'handle',
      username: 'alice',
      agent: 'backend',
    });
  });

  it('reads an agent id', () => {
    expect(parseRecipient(ALICE_BACKEND)).toStrictEqual({ kind: 'id', id: ALICE_BACKEND });
  });

  it.each(['alice/backend', '@alice', '@alice/', '@/backend', '@Alice/backend', '@alice/back end'])(
    'refuses %o',
    (raw) => {
      expect(() => parseRecipient(raw)).toThrow(/@user\/agent/);
    },
  );
});
