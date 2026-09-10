/**
 * `client.sessions`.
 *
 * The registration and teardown calls are thin and their shapes are asserted by
 * both sides compiling. What is pinned here is the listing, because two things
 * about it are not obvious from the signature and both are the kind of thing a
 * caller gets wrong once:
 *
 * **An empty list is not "no such agent".** The server scopes the query to the
 * caller's own agents, so a stranger's `agentId` produces `[]` rather than a
 * refusal (T-106). A client that surfaced an empty result as "not found" would
 * be inventing an answer the server deliberately declined to give.
 *
 * **`includeEnded` is sent only when it is on.** The server reads the exact
 * string `true`, so an omitted parameter and `?includeEnded=false` are the same
 * request, and sending the negative would only be noise on the wire.
 *
 * @module
 */

import type { SessionSummary } from '@stackgrid/protocol';
import { AgentId, ErrorCode, ProjectId, SessionId } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import { AgentChatClient } from '../client.js';
import { InMemoryCredentialStore } from '../credentials.js';
import { HttpTransport } from '../http-transport.js';
import type { MockServer as MockServerType } from '../testing/mock-server.js';
import { MOCK_BASE_URL, MockServer } from '../testing/mock-server.js';

const PROJECT = ProjectId.generate();
const AGENT = AgentId.generate();
const SESSION = SessionId.generate();

const LIST = 'GET /sessions';

/** One session, as the wire carries it. */
const SUMMARY: SessionSummary = {
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

/**
 * A signed-in client over a fresh mock server.
 *
 * @returns The client and the server behind it.
 */
function build(): { client: AgentChatClient; server: MockServerType } {
  const server = new MockServer();
  const client = new AgentChatClient({
    credentials: new InMemoryCredentialStore({ accessToken: 'at-1', refreshToken: 'rt-1' }),
    transport: new HttpTransport({ baseUrl: MOCK_BASE_URL, fetch: server.fetch() }),
  });
  return { client, server };
}

describe('sessions.list', () => {
  it('unwraps the envelope and keeps every field of the detail', async () => {
    const { client, server } = build();
    server.reply(LIST, { status: 200, body: { items: [SUMMARY] } });

    // The whole reason this endpoint exists rather than a count: the machine,
    // the runtime, the directory and the age all survive the round trip.
    await expect(client.sessions.list()).resolves.toStrictEqual([SUMMARY]);
  });

  it('sends no query at all when nothing was filtered', async () => {
    const { client, server } = build();
    server.reply(LIST, { status: 200, body: { items: [] } });

    await client.sessions.list();

    expect(server.calls[0]?.path).toBe('/sessions');
  });

  it('sends both filters when both were given', async () => {
    const { client, server } = build();
    server.reply(LIST, { status: 200, body: { items: [SUMMARY] } });

    await client.sessions.list({ projectId: PROJECT, agentId: AGENT });

    expect(server.calls[0]?.path).toContain(`projectId=${PROJECT}`);
    expect(server.calls[0]?.path).toContain(`agentId=${AGENT}`);
  });

  it('sends includeEnded only when it is on', async () => {
    // The server reads the exact string `true`, so an absent parameter and
    // `?includeEnded=false` are the same request.
    const { client, server } = build();
    server.reply(LIST, { status: 200, body: { items: [] } });

    await client.sessions.list({ includeEnded: false });
    expect(server.calls[0]?.path).not.toContain('includeEnded');

    await client.sessions.list({ includeEnded: true });
    expect(server.calls[1]?.path).toContain('includeEnded=true');
  });

  it('reports an empty list as an empty list, not as a failure', async () => {
    // This is what a stranger's `agentId` produces, and reading it as "no such
    // agent" would invent the answer the server declined to give.
    const { client, server } = build();
    server.reply(LIST, { status: 200, body: { items: [] } });

    await expect(client.sessions.list({ agentId: AgentId.generate() })).resolves.toEqual([]);
  });

  it('refuses a malformed filter here rather than spending a round trip', async () => {
    const { client, server } = build();

    await expect(client.sessions.list({ agentId: 'backend' })).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
    });
    expect(server.calls).toHaveLength(0);
  });
});
