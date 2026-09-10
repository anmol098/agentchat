/**
 * `agentchat listen`, driven in process against a fake socket.
 *
 * The suite under `../../tests/listen.test.ts` spawns the real binary and is
 * what proves the stream contract on two real file descriptors. This one covers
 * what a subprocess cannot observe from the outside, and two claims in
 * particular that would otherwise break in silence:
 *
 * - **The acknowledgement is sent after the write has flushed.** Every run here
 *   shares one `trace` array: the stdout double appends to it when a write
 *   starts and again when its callback fires, and the fake socket appends to it
 *   when a frame is sent. So the assertion is on the *interleaving*, not on the
 *   presence of an `ack` — move the acknowledgement to the point of delivery and
 *   the frame appears before `write:flush` and the test fails. The callback is
 *   deferred by a real timer rather than a microtask so that no amount of
 *   promise chaining can accidentally produce the right order.
 *
 * - **A dead pipe does not acknowledge.** The same double can refuse a write
 *   with `EPIPE`, which is what `listen --json | head -1` does to this process.
 *   The message must be left pending, because pending means it is replayed to
 *   the next listener and acknowledged means it is gone.
 *
 * @module
 */

import type {
  ConnectOptions,
  FrameConnector,
  FrameStream,
  SocketClosure,
  Transport,
  TransportRequest,
  TransportResponse,
} from '@stackgrid/client';
import { InMemoryCredentialStore } from '@stackgrid/client';
import {
  AgentId,
  ConversationId,
  ErrorCode,
  errorEnvelope,
  MessageId,
  ProjectId,
  SessionId,
  UserId,
} from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import type { ExitCode } from '../exit.js';
import { run } from '../main.js';
import type { OutputStream } from '../output/streams.js';
import { ScriptedInput } from '../testing.js';
import type { ListenOverrides } from './listen.js';
import { createListenCommand } from './listen.js';

const SERVER = 'https://chat.example.test';

const PROJECT = ProjectId.generate();
const ME = UserId.generate();
const BOB = UserId.generate();

const MY_BACKEND = AgentId.generate();
const BOB_BACKEND = AgentId.generate();

const SESSION = SessionId.generate();
const CONVERSATION = ConversationId.generate();

const ROSTER = `GET /projects/${PROJECT}/agents`;
const WHOAMI = 'GET /me';
const REGISTER = 'POST /sessions';
const END = `DELETE /sessions/${SESSION}`;

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

/** The roster every fixture sends into: one of mine, one of Bob's. */
const LISTING = [
  row(BOB_BACKEND, 'backend', { id: BOB, username: 'bob' }),
  row(MY_BACKEND, 'backend', { id: ME, username: 'you' }),
];

/**
 * A message envelope, as the server's delivery service builds one.
 *
 * @param over - Fields to vary.
 * @returns The `message` frame's payload.
 */
function envelope(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: MessageId.generate(),
    projectId: PROJECT,
    conversationId: CONVERSATION,
    senderAgentId: BOB_BACKEND,
    sender: '@bob/backend',
    recipientAgentId: MY_BACKEND,
    content: 'Can you verify the idempotency behaviour?',
    createdAt: '2026-09-09T12:00:00.000Z',
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

/** One scripted HTTP answer. */
interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

/** A transport that answers from a script instead of a socket. */
class StubServer implements Transport {
  public readonly calls: TransportRequest[] = [];
  readonly #replies = new Map<string, Reply>();

  /**
   * Scripts one endpoint.
   *
   * @param key - `METHOD /path`.
   * @param reply - What to answer with.
   * @returns This stub.
   */
  public on(key: string, reply: Reply): this {
    this.#replies.set(key, reply);
    return this;
  }

  /** Every call made, as `METHOD /path`, in order. */
  public get keys(): readonly string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  /**
   * The body of the first call to one endpoint.
   *
   * @param key - `METHOD /path`.
   * @returns The body, or `undefined` if it was never called.
   */
  public bodyOf(key: string): Record<string, unknown> | undefined {
    const call = this.calls.find((seen) => `${seen.method} ${seen.path}` === key);
    return call?.body as Record<string, unknown> | undefined;
  }

  /** @inheritdoc */
  public request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    const reply = this.#replies.get(`${request.method} ${request.path}`);
    if (reply === undefined) {
      return Promise.resolve({
        status: 404,
        headers: {},
        body: errorEnvelope(ErrorCode.NOT_FOUND, `No stub for ${request.method} ${request.path}.`),
      });
    }
    return Promise.resolve({ status: reply.status, headers: {}, body: reply.body ?? {} });
  }
}

/**
 * The HTTP half every case needs: the roster, the account, and a session.
 *
 * @returns The stub.
 */
function stubServer(): StubServer {
  return new StubServer()
    .on(ROSTER, { status: 200, body: { items: LISTING } })
    .on(WHOAMI, { status: 200, body: USER })
    .on(REGISTER, { status: 201, body: { sessionId: SESSION } })
    .on(END, { status: 200, body: { status: 'ended', endedAt: '2026-09-09T13:00:00.000Z' } });
}

/** A socket the test drives frame by frame. */
class FakeSocket implements FrameStream {
  /** Every frame the command sent, in order. */
  public readonly sent: Record<string, unknown>[] = [];

  /** @inheritdoc */
  public readonly closure: Promise<SocketClosure>;

  readonly #trace: string[];
  readonly #queue: unknown[] = [];
  readonly #waiting: ((result: IteratorResult<unknown>) => void)[] = [];
  #settle!: (closure: SocketClosure) => void;
  #ended = false;

  /**
   * @param trace - The shared ordering log; every frame sent is recorded in it.
   */
  public constructor(trace: string[]) {
    this.#trace = trace;
    this.closure = new Promise<SocketClosure>((resolve) => {
      this.#settle = resolve;
    });
  }

  /** Every acknowledged message, in the order the acknowledgements were sent. */
  public get acked(): readonly string[] {
    return this.sent
      .filter((frame) => frame['type'] === 'ack')
      .map((frame) => String(frame['messageId']));
  }

  /** The `hello` frame, if one was sent. */
  public get hello(): Record<string, unknown> | undefined {
    return this.sent.find((frame) => frame['type'] === 'hello');
  }

  /** @inheritdoc */
  public send(frame: unknown): void {
    const record = frame as Record<string, unknown>;
    this.sent.push(record);
    this.#trace.push(`send:${String(record['type'])}`);
  }

  /** @inheritdoc */
  public close(code = 1000, reason = ''): void {
    this.#finish({ code, reason, local: true, error: null });
  }

  /**
   * Hands one frame to the command.
   *
   * @param frame - The frame, as it would arrive decoded off the wire.
   */
  public deliver(frame: unknown): void {
    const waiter = this.#waiting.shift();
    if (waiter === undefined) {
      this.#queue.push(frame);
      return;
    }
    waiter({ value: frame, done: false });
  }

  /**
   * Ends the connection as the peer, which is what a reconnect follows.
   *
   * @param code - The close code the server sent.
   * @param reason - The close reason.
   */
  public drop(code: number, reason = 'dropped'): void {
    this.#finish({ code, reason, local: false, error: null });
  }

  /** @inheritdoc */
  public async *[Symbol.asyncIterator](): AsyncIterator<unknown> {
    for (;;) {
      const queued = this.#queue.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.#ended) {
        return;
      }
      const next = await new Promise<IteratorResult<unknown>>((resolve) => {
        this.#waiting.push(resolve);
      });
      if (next.done === true) {
        return;
      }
      yield next.value;
    }
  }

  /**
   * Settles the closure and releases anything waiting on a frame.
   *
   * @param closure - How the connection ended.
   */
  #finish(closure: SocketClosure): void {
    if (this.#ended) {
      return;
    }
    this.#ended = true;
    this.#settle(closure);
    for (const waiter of this.#waiting.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }
}

/** A connector that hands out {@link FakeSocket}s and says when it did. */
class FakeConnector implements FrameConnector {
  /** Every socket opened, in order. */
  public readonly sockets: FakeSocket[] = [];

  /** The connect options each attempt was made with. */
  public readonly attempts: ConnectOptions[] = [];

  readonly #trace: string[];
  readonly #waiting: (() => void)[] = [];

  /**
   * @param trace - The shared ordering log, handed to every socket.
   */
  public constructor(trace: string[]) {
    this.#trace = trace;
  }

  /** @inheritdoc */
  public connect(options: ConnectOptions): Promise<FrameStream> {
    this.attempts.push(options);
    const socket = new FakeSocket(this.#trace);
    this.sockets.push(socket);
    for (const waiter of this.#waiting.splice(0)) {
      waiter();
    }
    return Promise.resolve(socket);
  }

  /**
   * Waits until at least `count` sockets have been opened.
   *
   * @param count - How many.
   * @returns The most recent socket once there are that many.
   */
  public async socket(count = 1): Promise<FakeSocket> {
    while (this.sockets.length < count) {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
    }
    const socket = this.sockets[count - 1];
    if (socket === undefined) {
      throw new Error(`No socket ${String(count)}.`);
    }
    return socket;
  }
}

/**
 * A descriptor that records when each write started and when it flushed.
 *
 * The callback is deferred with `setTimeout` rather than `queueMicrotask`: an
 * acknowledgement sent from anywhere in the same microtask queue as the write
 * would beat a microtask callback by accident, and the ordering this suite
 * asserts has to be the real one.
 */
class TracingStream implements OutputStream {
  /** Everything written, concatenated. */
  public text = '';

  /** Whether writes fail with `EPIPE`, as a closed pipe does. */
  public broken = false;

  readonly #trace: string[];
  readonly #name: string;

  /**
   * @param trace - The shared ordering log.
   * @param name - How this descriptor appears in it.
   * @param isTTY - What the code under test should believe.
   */
  public constructor(
    trace: string[],
    name: string,
    public readonly isTTY: boolean = false,
  ) {
    this.#trace = trace;
    this.#name = name;
  }

  /** @inheritdoc */
  public write(chunk: string, callback: (error?: Error | null) => void): boolean {
    if (this.broken) {
      const error: NodeJS.ErrnoException = new Error('write EPIPE');
      error.code = 'EPIPE';
      setTimeout(() => {
        callback(error);
      }, 0);
      return false;
    }
    this.#trace.push(`${this.#name}:start`);
    this.text += chunk;
    setTimeout(() => {
      this.#trace.push(`${this.#name}:flush`);
      callback(null);
    }, 0);
    return true;
  }
}

// ---------------------------------------------------------------------------
// The harness
// ---------------------------------------------------------------------------

/** One in-flight invocation and everything a case drives it with. */
interface Harness {
  readonly stdout: TracingStream;
  readonly stderr: TracingStream;
  readonly trace: string[];
  readonly transport: StubServer;
  readonly connector: FakeConnector;
  readonly interrupt: AbortController;
  readonly exit: Promise<ExitCode>;
}

/** How to start one case. */
interface StartOptions {
  readonly transport?: StubServer;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly overrides?: Partial<ListenOverrides>;
}

/**
 * Starts `agentchat listen` and returns before it has finished.
 *
 * The command blocks by design, so a case drives the socket and then either
 * interrupts the run or lets the connection close for good.
 *
 * @param argv - The arguments after `listen`.
 * @param options - The HTTP stub, the environment, and extra seams.
 * @returns The in-flight run.
 */
function start(argv: readonly string[] = [], options: StartOptions = {}): Harness {
  const trace: string[] = [];
  const stdout = new TracingStream(trace, 'stdout');
  const stderr = new TracingStream(trace, 'stderr');
  const transport = options.transport ?? stubServer();
  const connector = new FakeConnector(trace);
  const interrupt = new AbortController();

  const exit = run({
    argv: ['listen', '--server', SERVER, ...argv],
    commands: [
      createListenCommand({
        store: new InMemoryCredentialStore({ accessToken: 'access', refreshToken: 'refresh' }),
        transport,
        connector: () => connector,
        hostname: () => 'test-host',
        ...options.overrides,
      }),
    ],
    env: {
      stdout,
      stderr,
      stdin: new ScriptedInput(),
      env: {
        XDG_CONFIG_HOME: '/nonexistent',
        AGENTCHAT_PROJECT: PROJECT,
        ...options.env,
      },
      cwd: '/work/payments',
    },
    signal: interrupt.signal,
  });

  return { stdout, stderr, trace, transport, connector, interrupt, exit };
}

/**
 * Waits until a predicate holds, or fails the test.
 *
 * Polls a real timer rather than counting microtasks: everything this suite
 * waits for crosses at least one `setTimeout`, because that is how the stdout
 * double defers its callbacks.
 *
 * @param what - Named in the failure.
 * @param predicate - Checked until it is true.
 * @returns When it holds.
 */
async function until(what: string, predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/**
 * Brings one socket up: waits for the attempt and answers `hello` with `ready`.
 *
 * @param harness - The run.
 * @param count - Which connection attempt, one-based.
 * @param pending - What `ready` should report.
 * @returns The connected socket.
 */
async function connected(harness: Harness, count = 1, pending = 0): Promise<FakeSocket> {
  const socket = await harness.connector.socket(count);
  await until('hello', () => socket.hello !== undefined);
  socket.deliver({ type: 'ready', sessionId: SESSION, pending });
  return socket;
}

/**
 * Interrupts a run and waits for its exit code.
 *
 * @param harness - The run.
 * @returns The exit code.
 */
async function interruptAndWait(harness: Harness): Promise<ExitCode> {
  harness.interrupt.abort(new Error('Interrupted by SIGINT.'));
  return await harness.exit;
}

/**
 * Every complete JSON line a run put on stdout.
 *
 * @param harness - The run.
 * @returns One parsed object per line.
 */
function events(harness: Harness): Record<string, unknown>[] {
  const text = harness.stdout.text;
  if (text === '') {
    return [];
  }
  expect(text.endsWith('\n')).toBe(true);
  return text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe('--runtime', () => {
  it('is required, and its absence is a usage error with nothing on stdout', async () => {
    const harness = start();

    expect(await harness.exit).toBe(2);
    expect(harness.stdout.text).toBe('');
    expect(harness.stderr.text).toContain('`--runtime` is required');
    expect(harness.transport.keys).toStrictEqual([]);
  });

  it('is read from the environment when the flag is absent', async () => {
    const harness = start([], { env: { AGENTCHAT_RUNTIME: 'codex' } });
    await connected(harness);

    expect(await interruptAndWait(harness)).toBe(0);
    expect(harness.transport.bodyOf(REGISTER)).toMatchObject({ runtime: 'codex' });
  });

  it('refuses an empty value rather than registering a session without one', async () => {
    const harness = start(['--runtime', '  ']);

    expect(await harness.exit).toBe(2);
    expect(harness.transport.keys).toStrictEqual([]);
  });
});

describe('the session', () => {
  it('is registered with the runtime, the machine and the working directory', async () => {
    const harness = start(['--runtime', 'claude-code']);
    await connected(harness);

    expect(await interruptAndWait(harness)).toBe(0);
    expect(harness.transport.bodyOf(REGISTER)).toStrictEqual({
      agentId: MY_BACKEND,
      projectId: PROJECT,
      machine: { name: 'test-host' },
      runtime: 'claude-code',
      workingDirectory: '/work/payments',
    });
  });

  it('is bound by hello on every connection, and ended on interrupt', async () => {
    const harness = start(['--runtime', 'claude-code']);
    const socket = await connected(harness);

    expect(socket.hello).toMatchObject({ type: 'hello', sessionId: SESSION });
    expect(await interruptAndWait(harness)).toBe(0);
    expect(harness.transport.keys).toContain(END);
  });

  it('is still ended when the teardown is what fails, and the run still exits 0', async () => {
    const transport = stubServer().on(END, {
      status: 500,
      body: errorEnvelope(ErrorCode.INTERNAL, 'nope'),
    });
    const harness = start(['--runtime', 'claude-code'], { transport });
    await connected(harness);

    expect(await interruptAndWait(harness)).toBe(0);
    expect(harness.stderr.text).toContain('Could not end session');
    expect(harness.stdout.text).toBe('');
  });
});

describe('human output', () => {
  it('prints the documented block with a ready-made reply command', async () => {
    const harness = start(['--runtime', 'claude-code']);
    const socket = await connected(harness);
    const message = envelope();
    socket.deliver({ type: 'message', message });

    await until('the message', () => harness.stdout.text.includes('Can you verify'));
    expect(await interruptAndWait(harness)).toBe(0);

    expect(harness.stdout.text).toBe(
      [
        '[agentchat message]',
        `id:           ${String(message['messageId'])}`,
        'from:         @bob/backend',
        `conversation: ${CONVERSATION}`,
        `reply:        agentchat send @bob/backend --conversation ${CONVERSATION} "…"`,
        '',
        'Can you verify the idempotency behaviour?',
        '',
        '',
      ].join('\n'),
    );
  });

  it('keeps every operational line off stdout', async () => {
    const harness = start(['--runtime', 'claude-code']);
    const socket = await connected(harness, 1, 3);
    socket.drop(1006);
    await until('the reconnect notice', () => harness.stderr.text.includes('Connection lost'));
    const second = await connected(harness, 2);
    second.deliver({ type: 'message', message: envelope({ content: 'only this' }) });
    await until('the message', () => harness.stdout.text.includes('only this'));

    expect(await interruptAndWait(harness)).toBe(0);
    expect(harness.stdout.text).not.toContain('Listening as');
    expect(harness.stdout.text).not.toContain('Connected');
    expect(harness.stdout.text).not.toContain('Connection lost');
    expect(harness.stderr.text).toContain('Listening as @you/backend');
    expect(harness.stderr.text).toContain('3 pending message(s) replayed');
  });

  it('names the agent when a flag chose it, so the reply is sent as that agent', async () => {
    const harness = start(['--runtime', 'claude-code', '--agent', 'backend']);
    const socket = await connected(harness);
    socket.deliver({ type: 'message', message: envelope() });
    await until('the message', () => harness.stdout.text.includes('reply:'));

    expect(await interruptAndWait(harness)).toBe(0);
    expect(harness.stdout.text).toContain(
      `reply:        agentchat send @bob/backend --agent backend --conversation ${CONVERSATION} "…"`,
    );
  });
});

describe('--json', () => {
  it('emits one object per event, including the connection states', async () => {
    const harness = start(['--runtime', 'claude-code', '--json']);
    const socket = await connected(harness, 1, 1);
    const message = envelope();
    socket.deliver({ type: 'message', message });
    await until('the message', () => harness.stdout.text.includes('"event":"message"'));
    socket.drop(1011);
    await until('the reconnect', () => harness.connector.sockets.length > 1);

    expect(await interruptAndWait(harness)).toBe(0);

    const seen = events(harness);
    expect(seen[0]).toStrictEqual({
      event: 'listening',
      sessionId: SESSION,
      agent: '@you/backend',
      agentId: MY_BACKEND,
      projectId: PROJECT,
      runtime: 'claude-code',
      ack: true,
    });
    expect(seen[1]).toStrictEqual({ event: 'status', state: 'connecting', attempt: 0 });
    expect(seen[2]).toStrictEqual({
      event: 'status',
      state: 'connected',
      sessionId: SESSION,
      pending: 1,
    });
    expect(seen[3]).toStrictEqual({ event: 'message', ...message });
    expect(seen.map((event) => event['state'])).toContain('reconnecting');
    expect(seen.at(-1)).toStrictEqual({
      event: 'status',
      state: 'disconnected',
      reason: 'stopped',
    });
    expect(harness.stderr.text).toContain('Listening as');
  });

  it('carries no reply hint, because a program has the identifiers', async () => {
    const harness = start(['--runtime', 'claude-code', '--json']);
    const socket = await connected(harness);
    socket.deliver({ type: 'message', message: envelope() });
    await until('the message', () => harness.stdout.text.includes('"event":"message"'));

    expect(await interruptAndWait(harness)).toBe(0);
    const message = events(harness).find((event) => event['event'] === 'message');
    expect(message).toBeDefined();
    expect(message).not.toHaveProperty('reply');
    expect(message).toMatchObject({ sender: '@bob/backend', conversationId: CONVERSATION });
  });

  it('passes a field this build has never heard of straight through', async () => {
    const harness = start(['--runtime', 'claude-code', '--json']);
    const socket = await connected(harness);
    socket.deliver({ type: 'message', message: envelope({ priority: 'high', labels: ['ops'] }) });
    await until('the message', () => harness.stdout.text.includes('"event":"message"'));

    expect(await interruptAndWait(harness)).toBe(0);
    expect(events(harness).find((event) => event['event'] === 'message')).toMatchObject({
      priority: 'high',
      labels: ['ops'],
    });
  });

  it('reports ack: false so a consumer knows it is responsible for acknowledging', async () => {
    const harness = start(['--runtime', 'claude-code', '--json', '--no-ack']);
    await connected(harness);

    expect(await interruptAndWait(harness)).toBe(0);
    expect(events(harness)[0]).toMatchObject({ event: 'listening', ack: false });
  });
});

describe('acknowledgement', () => {
  it('is sent only after the write to stdout has flushed', async () => {
    const harness = start(['--runtime', 'claude-code']);
    const socket = await connected(harness);
    const message = envelope();
    socket.deliver({ type: 'message', message });
    await until('the acknowledgement', () => socket.acked.length === 1);

    expect(await interruptAndWait(harness)).toBe(0);
    expect(socket.acked).toStrictEqual([message['messageId']]);

    // The whole claim, as an ordering: the frame cannot be sent before the
    // write it is acknowledging has reached the operating system.
    const flush = harness.trace.indexOf('stdout:flush');
    const ack = harness.trace.lastIndexOf('send:ack');
    expect(flush).toBeGreaterThanOrEqual(0);
    expect(ack).toBeGreaterThan(flush);
  });

  it('is not sent at all under --no-ack', async () => {
    const harness = start(['--runtime', 'claude-code', '--no-ack']);
    const socket = await connected(harness);
    socket.deliver({ type: 'message', message: envelope() });
    await until('the message', () => harness.stdout.text.includes('Can you verify'));

    expect(await interruptAndWait(harness)).toBe(0);
    expect(socket.acked).toStrictEqual([]);
  });

  it('is not sent when the write failed, so the message stays pending', async () => {
    const harness = start(['--runtime', 'claude-code', '--json']);
    const socket = await connected(harness);
    harness.stdout.broken = true;
    socket.deliver({ type: 'message', message: envelope() });

    // A reader that closed the pipe is not a failure; `main.ts` exits 0.
    expect(await harness.exit).toBe(0);
    expect(socket.acked).toStrictEqual([]);
    expect(harness.transport.keys).toContain(END);
  });

  it('is repeated for a replayed message, which is why it was replayed', async () => {
    const harness = start(['--runtime', 'claude-code']);
    const first = await connected(harness);
    const message = envelope();
    first.deliver({ type: 'message', message });
    await until('the first acknowledgement', () => first.acked.length === 1);

    // The acknowledgement was sent but never landed, so the server replays it.
    first.drop(1006);
    const second = await connected(harness, 2);
    second.deliver({ type: 'message', message });
    await until('the second acknowledgement', () => second.acked.length === 1);

    expect(await interruptAndWait(harness)).toBe(0);
    // Delivered once to the consumer, acknowledged on both connections.
    expect(harness.stdout.text.match(/\[agentchat message]/g)).toHaveLength(1);
    expect(second.acked).toStrictEqual([message['messageId']]);
  });
});

describe('a connection that will not come back', () => {
  it('exits 1 on a refused session rather than backing off forever', async () => {
    const harness = start(['--runtime', 'claude-code']);
    const socket = await connected(harness);
    socket.drop(4403, 'session is not active');

    expect(await harness.exit).toBe(1);
    expect(harness.connector.sockets).toHaveLength(1);
    expect(harness.stderr.text).toContain('code: SESSION_INVALID');
    expect(harness.stdout.text).toBe('');
    expect(harness.transport.keys).toContain(END);
  });

  it('exits 3 when the credentials are rejected twice', async () => {
    const transport = stubServer().on('POST /auth/refresh', {
      status: 401,
      body: errorEnvelope(ErrorCode.AUTH_REQUIRED, 'refresh token is spent'),
    });
    const harness = start(['--runtime', 'claude-code'], { transport });
    const socket = await connected(harness);
    socket.drop(4401, 'token expired');

    expect(await harness.exit).toBe(3);
    expect(harness.stdout.text).toBe('');
  });

  it('reports a refusal as one JSON error envelope and nothing else', async () => {
    const harness = start(['--runtime', 'claude-code', '--json']);
    const socket = await connected(harness);
    socket.drop(4403, 'session is not active');

    expect(await harness.exit).toBe(1);
    const seen = events(harness);
    expect(seen.at(-1)).toMatchObject({ error: { code: 'SESSION_INVALID' } });
    expect(seen.filter((event) => event['event'] === 'message')).toStrictEqual([]);
  });
});
