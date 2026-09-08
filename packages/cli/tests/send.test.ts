/**
 * `agentchat send`, spawned.
 *
 * The acceptance tests for T-311. Like the rest of this directory they start a
 * real process against a real socket and read file descriptor 1 and file
 * descriptor 2 **separately** (`./spawn.ts`).
 *
 * That separation matters more here than anywhere else so far, because this is
 * the command an AI coding agent runs from a script: it pipes a body in on file
 * descriptor 0 and parses a document off file descriptor 1, and a suite that
 * merged the descriptors would pass while the contract it protects was broken
 * (PRD §39). So every case asserts on both streams, and the `--json` cases
 * assert that stdout is exactly one parseable document with no ANSI in it — the
 * child's descriptors are pipes, so colour must vanish on its own.
 *
 * The standard-input case is the reason this file spawns rather than stubbing a
 * descriptor: the body travels through a real pipe, is written by a real
 * `child.stdin.end()`, and is asserted back byte for byte from what the server
 * actually received. A trailing newline that a helper had quietly stripped
 * would show up here and nowhere else.
 *
 * Every run gets its own `HOME` and its own working directory, so nothing here
 * can read the developer's credentials or their repository configuration.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Run } from './spawn.js';
import { ANSI, buildPackage, parseNdjson, runCli } from './spawn.js';

const PROJECT_ID = 'prj_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d7';
const ME_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d8';
const ALICE_ID = 'usr_0199a1b2-c3d4-7e5f-8071-8293a4b5c6d9';

const MY_BACKEND = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e1';
const ALICE_BACKEND = 'agt_0199a1b2-c3d4-7e5f-8071-8293a4b5c6e2';

const MESSAGE_ID = 'msg_0199a1b2-c3d4-7e5f-8071-8293a4b5c6f1';
const PARENT_ID = 'msg_0199a1b2-c3d4-7e5f-8071-8293a4b5c6f2';
const CONVERSATION_ID = 'cnv_0199a1b2-c3d4-7e5f-8071-8293a4b5c6f3';

/** The account the stub server answers for. */
const ME = {
  id: ME_ID,
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
 * @param owner - The account id and username of the owner.
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

/** The roster: one agent of mine, one of Alice's. */
const LISTING = [
  row(ALICE_BACKEND, 'backend', { id: ALICE_ID, username: 'alice' }),
  row(MY_BACKEND, 'backend', { id: ME_ID, username: 'you' }),
];

/**
 * The message the stub commits.
 *
 * @param over - Fields to vary.
 * @returns The wire representation.
 */
function committed(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MESSAGE_ID,
    projectId: PROJECT_ID,
    conversationId: CONVERSATION_ID,
    parentMessageId: null,
    senderAgentId: MY_BACKEND,
    recipientAgentId: ALICE_BACKEND,
    content: 'the server does not echo this back to the receipt',
    createdAt: '2026-09-08T12:00:00.000Z',
    ...over,
  };
}

/** One stubbed answer. */
interface Reply {
  readonly status: number;
  readonly body: unknown;
}

/** The routes the stub answers, keyed by `METHOD /path`. */
type Routes = Readonly<Record<string, Reply>>;

/**
 * The listings every fixture needs, plus whatever the case adds.
 *
 * @param extra - Routes to add or replace.
 * @returns The route table.
 */
function baseRoutes(extra: Routes = {}): Routes {
  return {
    'GET /me': { status: 200, body: ME },
    [`GET /projects/${PROJECT_ID}/agents`]: { status: 200, body: { items: LISTING } },
    'POST /messages': { status: 201, body: committed() },
    ...extra,
  };
}

let server: Server;
let baseUrl: string;
let routes: Routes = {};
let sent: Record<string, unknown>[] = [];
let root: string;

/**
 * Reads a request body to the end.
 *
 * @param request - The incoming request.
 * @returns The body as text.
 */
async function bodyOf(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

beforeAll(async () => {
  await buildPackage();
  root = mkdtempSync(join(tmpdir(), 'agentchat-send-cli-'));

  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? 'GET';
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const key = `${method} ${path}`;

    void bodyOf(request).then((text) => {
      if (key === 'POST /messages' && text !== '') {
        sent.push(JSON.parse(text) as Record<string, unknown>);
      }
      const reply = routes[key] ?? {
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: `No stub for ${key}.` } },
      };
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  routes = baseRoutes();
  sent = [];
});

/** A prepared fixture: a fake home and a working directory. */
interface Prepared {
  /** The fake `HOME`. */
  readonly home: string;

  /** Where the command runs. */
  readonly cwd: string;
}

/**
 * Builds one throwaway home, logged in and pointed at the stub server.
 *
 * @returns The paths to run against.
 */
function prepare(): Prepared {
  const base = mkdtempSync(join(root, 'case-'));
  const home = join(base, 'home');
  const cwd = join(base, 'work');
  const configDirectory = join(home, '.config', 'agentchat');
  mkdirSync(cwd, { recursive: true });
  mkdirSync(configDirectory, { recursive: true, mode: 0o700 });

  writeFileSync(
    join(configDirectory, 'credentials.json'),
    `${JSON.stringify({ version: 1, accessToken: 'access-token', refreshToken: 'refresh-token' }, null, 2)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(configDirectory, 'config.json'),
    `${JSON.stringify({ serverUrl: baseUrl, defaultAgentByProject: {} }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { home, cwd };
}

/**
 * Runs `agentchat send …` against a fixture.
 *
 * @param prepared - The home and working directory to run in.
 * @param argv - The arguments after `send`.
 * @param stdin - What to write to the child's standard input before closing it.
 * @returns Both streams and the exit code.
 */
async function sendCli(prepared: Prepared, argv: readonly string[], stdin = ''): Promise<Run> {
  return await runCli(['send', ...argv], {
    cwd: prepared.cwd,
    env: { HOME: prepared.home, AGENTCHAT_PROJECT: PROJECT_ID },
    stdin,
  });
}

describe('send --json', () => {
  it('puts one JSON document on stdout and nothing at all on stderr', async () => {
    const run = await sendCli(prepare(), ['@alice/backend', 'the build is green', '--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).not.toMatch(ANSI);

    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toStrictEqual({
      messageId: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      parentMessageId: null,
      projectId: PROJECT_ID,
      clientMessageId: expect.any(String),
      duplicate: false,
      createdAt: '2026-09-08T12:00:00.000Z',
      contentBytes: 18,
      sender: { address: '@you/backend', agentId: MY_BACKEND },
      recipient: { address: '@alice/backend', agentId: ALICE_BACKEND },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      projectId: PROJECT_ID,
      senderAgentId: MY_BACKEND,
      recipientAgentId: ALICE_BACKEND,
      content: 'the build is green',
    });
  });

  it('reports a duplicate as a success, on stdout, with exit 0', async () => {
    routes = baseRoutes({ 'POST /messages': { status: 200, body: committed() } });

    const run = await sendCli(prepare(), ['@alice/backend', 'the build is green', '--json']);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(parseNdjson(run.stdout)[0]).toMatchObject({
      duplicate: true,
      messageId: MESSAGE_ID,
    });
  });
});

describe('a body on standard input', () => {
  it('travels through a real pipe unchanged, trailing newline and all', async () => {
    const body = '## Release notes\r\n\n  * fixed the é encoding\n';

    const run = await sendCli(prepare(), ['@alice/backend', '-', '--json'], body);

    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(sent[0]?.['content']).toBe(body);
    expect(parseNdjson(run.stdout)[0]).toMatchObject({
      contentBytes: Buffer.byteLength(body, 'utf8'),
    });
  });

  it('carries a body far too large for an argument list', async () => {
    // Well past `ARG_MAX` on every platform this runs on, so the only way this
    // message can be sent at all is the one under test.
    const body = 'x'.repeat(400_000);

    const run = await sendCli(prepare(), ['@alice/backend', '-', '--json'], body);

    expect(run.code).toBe(0);
    expect(sent[0]?.['content']).toBe(body);
  });

  it('refuses a body over the megabyte limit and sends nothing', async () => {
    const run = await sendCli(prepare(), ['@alice/backend', '-'], 'x'.repeat(1_048_600));

    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('1,048,576');
    expect(sent).toHaveLength(0);
  });
});

describe('threading', () => {
  it('sends a reply and reports the conversation the server inherited for it', async () => {
    routes = baseRoutes({
      'POST /messages': {
        status: 201,
        body: committed({ parentMessageId: PARENT_ID }),
      },
    });

    const run = await sendCli(prepare(), [
      '@alice/backend',
      'on it',
      '--reply-to',
      PARENT_ID,
      '--json',
    ]);

    expect(run.code).toBe(0);
    expect(sent[0]).toMatchObject({ parentMessageId: PARENT_ID });
    // The reply carried no conversation of its own; the one in the receipt is
    // the parent's, as the server resolved it.
    expect(sent[0]?.['conversationId']).toBeUndefined();
    expect(parseNdjson(run.stdout)[0]).toMatchObject({
      parentMessageId: PARENT_ID,
      conversationId: CONVERSATION_ID,
    });
  });

  it('sends into an existing conversation', async () => {
    const run = await sendCli(prepare(), [
      '@alice/backend',
      'still here',
      '--conversation',
      CONVERSATION_ID,
      '--json',
    ]);

    expect(run.code).toBe(0);
    expect(sent[0]).toMatchObject({ conversationId: CONVERSATION_ID });
  });
});

describe('failures', () => {
  it('names the discovery command for an unknown recipient, on stderr only', async () => {
    const run = await sendCli(prepare(), ['@carol/backend', 'hello']);

    expect(run.code).not.toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('agentchat agents');
    expect(sent).toHaveLength(0);
  });

  it('keeps stdout valid JSON when it fails in --json mode', async () => {
    const run = await sendCli(prepare(), ['@carol/backend', 'hello', '--json']);

    expect(run.code).not.toBe(0);
    expect(run.stdout).not.toMatch(ANSI);
    const documents = parseNdjson(run.stdout);
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});
