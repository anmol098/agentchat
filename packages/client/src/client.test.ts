import type { ProjectId as ProjectIdType } from '@agentchat/protocol';
import { AgentId, CLIENT_VERSION_HEADER, ErrorCode, ProjectId, UserId } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import { AgentChatClient } from './client.js';
import type { Credentials } from './credentials.js';
import { InMemoryCredentialStore } from './credentials.js';
import { ApiError, ResponseFormatError, TransportError } from './errors.js';
import { HttpTransport } from './http-transport.js';
import type { MockReply, RecordedRequest } from './testing/mock-server.js';
import { envelope, MOCK_BASE_URL, MockServer } from './testing/mock-server.js';

const START: Credentials = { accessToken: 'at-1', refreshToken: 'rt-1' };

const user = {
  id: UserId.generate(),
  username: 'alice',
  displayName: 'Alice',
  email: 'alice@example.com',
  createdAt: '2026-09-08T12:00:00.000Z',
};

const projectId = ProjectId.generate();

const project = {
  id: projectId,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: user.id,
  createdAt: '2026-09-08T12:00:00.000Z',
  role: 'owner',
};

/** Builds a client wired to a fresh mock server. */
function build(options: { credentials?: Credentials | null; clientVersion?: string } = {}): {
  client: AgentChatClient;
  server: MockServer;
  store: InMemoryCredentialStore;
} {
  const server = new MockServer();
  const store = new InMemoryCredentialStore(
    options.credentials === undefined ? START : options.credentials,
  );
  const client = new AgentChatClient({
    credentials: store,
    transport: new HttpTransport({ baseUrl: MOCK_BASE_URL, fetch: server.fetch() }),
    ...(options.clientVersion === undefined ? {} : { clientVersion: options.clientVersion }),
  });
  return { client, server, store };
}

/**
 * A route that rejects the old access token and accepts the rotated one.
 *
 * @param body - What to answer once the caller presents a current token.
 * @returns The route.
 */
function guarded(body: unknown): (request: RecordedRequest) => MockReply {
  return (request) =>
    request.headers['authorization'] === 'Bearer at-1'
      ? { status: 401, body: envelope('AUTH_REQUIRED', 'Access token expired.') }
      : { status: 200, body };
}

/** The standard rotating refresh route: rt-N is accepted once, then revokes. */
function rotatingRefresh(server: MockServer): void {
  const spent = new Set<string>();
  let generation = 1;
  server.on('POST /auth/refresh', (request) => {
    const presented = (request.body as { refreshToken?: string } | undefined)?.refreshToken ?? '';
    if (spent.has(presented)) {
      // What the real server does: reuse of a rotated token revokes the chain.
      return { status: 401, body: envelope('AUTH_REQUIRED', 'Refresh token reuse detected.') };
    }
    spent.add(presented);
    generation += 1;
    return {
      status: 200,
      body: { accessToken: `at-${generation}`, refreshToken: `rt-${generation}` },
    };
  });
}

describe('AgentChatClient construction', () => {
  it('rejects a base URL that is not absolute, at construction rather than at first use', () => {
    expect(
      () =>
        new AgentChatClient({
          baseUrl: 'chat.example.com',
          credentials: new InMemoryCredentialStore(),
        }),
    ).toThrow(/absolute server URL/);
  });

  it('rejects being built with neither a base URL nor a transport', () => {
    expect(() => new AgentChatClient({ credentials: new InMemoryCredentialStore() })).toThrow(
      /absolute server URL/,
    );
  });

  it('exposes its transport so a listener implementation can ask what it supports', () => {
    const { client } = build();
    expect(client.transport).toBeInstanceOf(HttpTransport);
    expect(client.transport.connect).toBeUndefined();
  });
});

describe('the client version header', () => {
  it('is sent on every request when the caller has a version to claim', async () => {
    const { client, server } = build({ clientVersion: '0.1.0' });
    server.reply('GET /agents', { status: 200, body: { items: [] } });
    server.reply('GET /version', {
      status: 200,
      body: { version: '0.1.0', protocolVersion: 1, minClientVersion: '0.1.0' },
    });

    await client.agents.list();
    await client.version.get();

    expect(server.calls).toHaveLength(2);
    for (const call of server.calls) {
      expect(call.headers[CLIENT_VERSION_HEADER]).toBe('agentchat/0.1.0');
    }
  });

  it('is omitted when the embedder is not the agentchat CLI', async () => {
    const { client, server } = build();
    server.reply('GET /agents', { status: 200, body: { items: [] } });

    await client.agents.list();

    expect(server.calls[0]?.headers[CLIENT_VERSION_HEADER]).toBeUndefined();
  });

  it('refuses a version that is not a semantic version, rather than sending a header the server will reject', () => {
    expect(() => build({ clientVersion: 'v0.1' })).toThrow();
  });

  it("surfaces the server's upgrade demand with its stable code", async () => {
    const { client, server } = build({ clientVersion: '0.1.0' });
    server.reply('GET /agents', {
      status: 426,
      body: envelope('UPGRADE_REQUIRED', 'Server requires agentchat >= 1.0.0.'),
    });

    await expect(client.agents.list()).rejects.toMatchObject({
      code: ErrorCode.UPGRADE_REQUIRED,
      status: 426,
    });
  });
});

describe('authentication headers', () => {
  it('sends the bearer token on an authenticated call', async () => {
    const { client, server } = build();
    server.reply('GET /me', { status: 200, body: user });

    await client.auth.me();

    expect(server.calls[0]?.headers['authorization']).toBe('Bearer at-1');
  });

  it('sends none on the endpoints that are unauthenticated by design', async () => {
    const { client, server } = build();
    server.reply('GET /version', {
      status: 200,
      body: { version: '0.1.0', protocolVersion: 1, minClientVersion: '0.1.0' },
    });
    server.reply('POST /auth/device/start', {
      status: 200,
      body: {
        deviceCode: 'dc-1',
        userCode: 'ABCD-1234',
        verificationUri: 'https://github.com/login/device',
        interval: 5,
        expiresIn: 900,
      },
    });

    await client.version.get();
    await client.auth.startDeviceAuthorization();

    for (const call of server.calls) {
      expect(call.headers['authorization']).toBeUndefined();
    }
  });

  it('fails with AUTH_REQUIRED before making a request when nobody is logged in', async () => {
    const { client, server } = build({ credentials: null });

    await expect(client.agents.list()).rejects.toMatchObject({ code: ErrorCode.AUTH_REQUIRED });
    expect(server.calls).toHaveLength(0);
  });
});

describe('token refresh', () => {
  it('refreshes once and retries once when the access token has expired', async () => {
    const { client, server, store } = build();
    rotatingRefresh(server);
    server.on('GET /agents', guarded({ items: [] }));

    await expect(client.agents.list()).resolves.toStrictEqual({ items: [] });

    expect(server.countOf('POST /auth/refresh')).toBe(1);
    expect(server.countOf('GET /agents')).toBe(2);
    await expect(store.load()).resolves.toStrictEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    });
  });

  it('retries with the new token, not the one that just failed', async () => {
    const { client, server } = build();
    rotatingRefresh(server);
    server.on('GET /agents', guarded({ items: [] }));

    await client.agents.list();

    const attempts = server.calls.filter((call) => call.path === '/agents');
    expect(attempts[0]?.headers['authorization']).toBe('Bearer at-1');
    expect(attempts[1]?.headers['authorization']).toBe('Bearer at-2');
  });

  it('gives up after one retry rather than refreshing in a loop', async () => {
    const { client, server } = build();
    rotatingRefresh(server);
    server.reply('GET /agents', {
      status: 401,
      body: envelope('AUTH_REQUIRED', 'Access token expired.'),
    });

    await expect(client.agents.list()).rejects.toMatchObject({
      code: ErrorCode.AUTH_REQUIRED,
    });

    expect(server.countOf('GET /agents')).toBe(2);
    expect(server.countOf('POST /auth/refresh')).toBe(1);
  });

  it('never refreshes in response to a 401 from the refresh endpoint itself', async () => {
    const { client, server, store } = build();
    server.reply('POST /auth/refresh', {
      status: 401,
      body: envelope('AUTH_REQUIRED', 'Refresh token revoked.'),
    });
    server.reply('GET /agents', {
      status: 401,
      body: envelope('AUTH_REQUIRED', 'Access token expired.'),
    });

    await expect(client.agents.list()).rejects.toMatchObject({
      code: ErrorCode.AUTH_REQUIRED,
    });

    expect(server.countOf('POST /auth/refresh')).toBe(1);
    await expect(store.load()).resolves.toBeNull();
  });

  it('refreshes exactly once for a fan-out of concurrent requests that all expire together', async () => {
    // The case that logs a user out if it is handled naively: five 401s, five
    // refreshes, four of them presenting an already-rotated token, and the
    // server revoking the chain on the first reuse.
    const { client, server, store } = build();
    rotatingRefresh(server);
    server.on('GET /agents', guarded({ items: [] }));
    server.on('GET /projects', guarded({ items: [project] }));
    server.on('GET /me', guarded(user));

    const [agents, projects] = await Promise.all([
      client.agents.list(),
      client.projects.list(),
      client.auth.me(),
      client.agents.list(),
      client.auth.me(),
    ]);

    expect(server.countOf('POST /auth/refresh')).toBe(1);
    expect(agents.items).toStrictEqual([]);
    expect(projects.items).toHaveLength(1);
    await expect(store.load()).resolves.toStrictEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    });
  });

  it('does not refresh again for a 401 that arrives after the refresh has landed', async () => {
    // Staggered rather than simultaneous. Both requests read the store before
    // anything expired, so both carry at-1; the second one's reply is held until
    // the first has already refreshed. Its 401 is therefore stale, and there is
    // no in-flight refresh left to join — the case a single-flight latch alone
    // does not cover, and the one that revokes the chain if it is missed.
    const { client, server } = build();
    rotatingRefresh(server);

    let releaseSecond: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    server.on('GET /agents', async (request, callCount) => {
      if (request.headers['authorization'] !== 'Bearer at-1') {
        return { status: 200, body: { items: [] } };
      }
      if (callCount === 1) {
        await held;
      }
      return { status: 401, body: envelope('AUTH_REQUIRED', 'Access token expired.') };
    });

    const first = client.agents.list();
    const second = client.agents.list();

    await expect(first).resolves.toStrictEqual({ items: [] });
    releaseSecond();

    await expect(second).resolves.toStrictEqual({ items: [] });
    expect(server.countOf('POST /auth/refresh')).toBe(1);
  });

  it('does not attempt a refresh when the failure is not a 401', async () => {
    const { client, server } = build();
    rotatingRefresh(server);
    server.reply('GET /agents', { status: 403, body: envelope('FORBIDDEN', 'No.') });

    await expect(client.agents.list()).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });

    expect(server.countOf('POST /auth/refresh')).toBe(0);
    expect(server.countOf('GET /agents')).toBe(1);
  });
});

describe('error translation', () => {
  it('preserves the stable code the server sent', async () => {
    const { client, server } = build();
    server.reply('POST /projects', { status: 409, body: envelope('CONFLICT', 'Slug taken.') });

    const failure = await client.projects
      .create({ name: 'Payments Platform', slug: 'payments' })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).code).toBe(ErrorCode.CONFLICT);
    expect((failure as ApiError).wireCode).toBe('CONFLICT');
    expect((failure as ApiError).message).toBe('Slug taken.');
  });

  it('keeps a code a newer server invented, instead of failing to parse the envelope', async () => {
    const { client, server } = build();
    server.reply('GET /agents', { status: 429, body: envelope('RATE_LIMITED', 'Slow down.') });

    const failure = (await client.agents.list().catch((error: unknown) => error)) as ApiError;

    expect(failure.wireCode).toBe('RATE_LIMITED');
    expect(failure.isKnownCode).toBe(false);
    expect(failure.code).toBe(ErrorCode.INTERNAL);
    expect(failure.status).toBe(429);
  });

  it('turns a proxy error page into a legible failure rather than a parse error', async () => {
    const { client, server } = build();
    server.reply('GET /agents', {
      status: 502,
      rawBody: '<html>Bad Gateway</html>',
      headers: { 'content-type': 'text/html' },
    });

    const failure = (await client.agents.list().catch((error: unknown) => error)) as ApiError;

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(502);
    expect(failure.code).toBe(ErrorCode.INTERNAL);
  });

  it("refuses a success body that does not match the endpoint's schema", async () => {
    const { client, server } = build();
    server.reply('GET /agents', { status: 200, body: [{ id: 'agt_1' }] });

    await expect(client.agents.list()).rejects.toThrow(ResponseFormatError);
  });

  it('refuses a list that arrives as a bare array, which the envelope decision forbids', async () => {
    const { client, server } = build();
    server.reply('GET /projects', { status: 200, body: [project] });

    await expect(client.projects.list()).rejects.toThrow(ResponseFormatError);
  });

  it('surfaces an unreachable server as a TransportError, not as a server fault', async () => {
    const store = new InMemoryCredentialStore(START);
    const client = new AgentChatClient({
      credentials: store,
      transport: new HttpTransport({
        baseUrl: MOCK_BASE_URL,
        fetch: () => Promise.reject(new TypeError('fetch failed')),
      }),
    });

    await expect(client.agents.list()).rejects.toThrow(TransportError);
  });
});

describe('typed methods', () => {
  it('reads the version handshake without credentials', async () => {
    const { client, server } = build({ credentials: null });
    server.reply('GET /version', {
      status: 200,
      body: { version: '0.2.0', protocolVersion: 1, minClientVersion: '0.1.0' },
    });

    await expect(client.version.get()).resolves.toStrictEqual({
      version: '0.2.0',
      protocolVersion: 1,
      minClientVersion: '0.1.0',
    });
  });

  it('persists the tokens a device poll returns, so the next call is authenticated', async () => {
    const { client, server, store } = build({ credentials: null });
    server.reply('POST /auth/device/poll', {
      status: 200,
      body: { accessToken: 'at-new', refreshToken: 'rt-new', user },
    });
    server.reply('GET /me', { status: 200, body: user });

    await client.auth.pollDeviceAuthorization({ deviceCode: 'dc-1' });
    await client.auth.me();

    await expect(store.load()).resolves.toStrictEqual({
      accessToken: 'at-new',
      refreshToken: 'rt-new',
    });
    expect(server.calls[1]?.headers['authorization']).toBe('Bearer at-new');
  });

  it('reports a poll that is still waiting as AUTH_PENDING rather than as a value', async () => {
    const { client, server } = build({ credentials: null });
    server.reply('POST /auth/device/poll', {
      status: 428,
      body: envelope('AUTH_PENDING', 'Waiting for approval.'),
    });

    await expect(client.auth.pollDeviceAuthorization({ deviceCode: 'dc-1' })).rejects.toMatchObject(
      {
        code: ErrorCode.AUTH_PENDING,
      },
    );
  });

  it('revokes the refresh token on logout and forgets it locally', async () => {
    const { client, server, store } = build();
    server.reply('POST /auth/logout', { status: 200, body: {} });

    await client.auth.logout();

    expect(server.calls[0]?.body).toStrictEqual({ refreshToken: 'rt-1' });
    await expect(store.load()).resolves.toBeNull();
  });

  it('makes no request when logging out of a session that does not exist', async () => {
    const { client, server } = build({ credentials: null });
    await client.auth.logout();
    expect(server.calls).toHaveLength(0);
  });

  it('clears the local credentials even when the server could not be told', async () => {
    const store = new InMemoryCredentialStore(START);
    const client = new AgentChatClient({
      credentials: store,
      transport: new HttpTransport({
        baseUrl: MOCK_BASE_URL,
        fetch: () => Promise.reject(new TypeError('fetch failed')),
      }),
    });

    await expect(client.auth.logout()).rejects.toThrow(TransportError);
    await expect(store.load()).resolves.toBeNull();
  });

  it('lists projects in the envelope the protocol defines', async () => {
    const { client, server } = build();
    server.reply('GET /projects', { status: 200, body: { items: [project] } });

    const listed = await client.projects.list();
    expect(listed.items[0]?.slug).toBe('payments');
  });

  it('builds a project-scoped path from a branded id', async () => {
    const { client, server } = build();
    server.reply(`GET /projects/${projectId}/agents`, { status: 200, body: { items: [] } });

    await client.projects.listAgents(projectId);

    expect(server.calls[0]?.path).toBe(`/projects/${projectId}/agents`);
  });

  it('validates a request body before sending it', async () => {
    const { client, server } = build();
    server.reply('POST /agents', { status: 200, body: {} });

    await expect(client.agents.create({ name: 'Not A Valid Name' })).rejects.toThrow();
    expect(server.calls).toHaveLength(0);
  });

  it('refuses an invite code that could not be a safe path segment', async () => {
    const { client, server } = build();

    await expect(client.invites.preview('../../admin')).rejects.toMatchObject({
      code: ErrorCode.BAD_REQUEST,
    });
    expect(server.calls).toHaveLength(0);
  });

  it('previews an invite for a caller who is a member of nothing', async () => {
    const { client, server } = build();
    server.reply('GET /invites/ANET-7K4M-Q2P9', {
      status: 200,
      body: {
        project: {
          id: projectId,
          slug: 'payments',
          name: 'Payments Platform',
          createdBy: user.id,
          createdAt: '2026-09-08T12:00:00.000Z',
        },
        invitedBy: { id: user.id, username: 'alice', displayName: 'Alice' },
      },
    });

    const preview = await client.invites.preview('ANET-7K4M-Q2P9');
    expect(preview.invitedBy.displayName).toBe('Alice');
  });

  it('sends the project id in the body when joining an agent to a project', async () => {
    const { client, server } = build();
    const agentId = AgentId.generate();
    server.reply(`POST /agents/${agentId}/projects`, { status: 200, body: {} });

    await client.agents.addToProject(agentId, { projectId });

    expect(server.calls[0]?.path).toBe(`/agents/${agentId}/projects`);
    expect(server.calls[0]?.body).toStrictEqual({ projectId });
  });

  it('rejects a project id that is not a well-formed identifier before sending it', async () => {
    const { client, server } = build();
    const agentId = AgentId.generate();

    await expect(
      client.agents.addToProject(agentId, { projectId: 'not-an-id' as ProjectIdType }),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(server.calls).toHaveLength(0);
  });

  it('renames an agent and returns the row the server now holds', async () => {
    const { client, server } = build();
    const agentId = AgentId.generate();
    const agent = {
      id: agentId,
      userId: user.id,
      name: 'frontend',
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T12:30:00.000Z',
    };
    server.reply(`PATCH /agents/${agentId}`, { status: 200, body: agent });

    await expect(client.agents.rename(agentId, { name: 'frontend' })).resolves.toStrictEqual(agent);
    expect(server.calls[0]?.method).toBe('PATCH');
    expect(server.calls[0]?.body).toStrictEqual({ name: 'frontend' });
  });

  it('soft-deletes an agent with no body in either direction', async () => {
    const { client, server } = build();
    const agentId = AgentId.generate();
    server.reply(`DELETE /agents/${agentId}`, { status: 200, body: {} });

    await expect(client.agents.delete(agentId)).resolves.toBeUndefined();
    expect(server.calls[0]?.method).toBe('DELETE');
    expect(server.calls[0]?.body).toBeUndefined();
  });

  it('reports a stale agent id with AGENT_DELETED rather than NOT_FOUND', async () => {
    const { client, server } = build();
    const agentId = AgentId.generate();
    server.reply(`PATCH /agents/${agentId}`, {
      status: 410,
      body: envelope('AGENT_DELETED', 'That agent was deleted.'),
    });

    await expect(client.agents.rename(agentId, { name: 'frontend' })).rejects.toMatchObject({
      code: ErrorCode.AGENT_DELETED,
    });
  });

  it('removes an agent from one project without touching its other memberships', async () => {
    const { client, server } = build();
    const agentId = AgentId.generate();
    server.reply(`DELETE /agents/${agentId}/projects/${projectId}`, { status: 200, body: {} });

    await expect(client.agents.removeFromProject(agentId, projectId)).resolves.toBeUndefined();
  });

  it("reads one project with the caller's role in it", async () => {
    const { client, server } = build();
    server.reply(`GET /projects/${projectId}`, { status: 200, body: project });

    await expect(client.projects.get(projectId)).resolves.toMatchObject({ role: 'owner' });
  });

  it('hides whether a project exists from a caller who is not a member', async () => {
    const { client, server } = build();
    server.reply(`GET /projects/${projectId}`, {
      status: 404,
      body: envelope('NOT_FOUND', 'No such project.'),
    });

    await expect(client.projects.get(projectId)).rejects.toMatchObject({
      code: ErrorCode.NOT_FOUND,
    });
  });

  it('mints an invite code for any member, not only an owner', async () => {
    const { client, server } = build();
    server.reply(`POST /projects/${projectId}/invites`, {
      status: 200,
      body: { code: 'ANET-7K4M-Q2P9', expiresAt: '2026-09-15T12:00:00.000Z' },
    });

    const invite = await client.projects.createInvite(projectId);
    expect(invite.code).toBe('ANET-7K4M-Q2P9');
  });

  it('joins a project by code and returns the membership it created', async () => {
    const { client, server } = build();
    server.reply('POST /invites/ANET-7K4M-Q2P9/join', {
      status: 200,
      body: { project: { ...project, role: 'member' } },
    });

    const joined = await client.invites.join('ANET-7K4M-Q2P9');
    expect(joined.project.role).toBe('member');
  });

  it('reports an unusable invite code with the one code that covers every reason', async () => {
    const { client, server } = build();
    server.reply('POST /invites/ANET-7K4M-Q2P9/join', {
      status: 404,
      body: envelope('INVITE_INVALID', 'That invite is no longer valid.'),
    });

    await expect(client.invites.join('ANET-7K4M-Q2P9')).rejects.toMatchObject({
      code: ErrorCode.INVITE_INVALID,
    });
  });

  it('accepts an empty body on the mutations whose response has no fields', async () => {
    const { client, server } = build();
    server.reply(`POST /projects/${projectId}/leave`, { status: 200 });

    await expect(client.projects.leave(projectId)).resolves.toBeUndefined();
  });
});
