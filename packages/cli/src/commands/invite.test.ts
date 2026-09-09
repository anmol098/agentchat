/**
 * `agentchat project revoke-invite`, driven in process against a stubbed
 * server.
 *
 * Driven through {@link createProjectCommand} rather than through
 * {@link createProjectRevokeInviteCommand} alone, so that the composition is
 * under test too: a command implemented here and never added to the group would
 * pass every assertion about its own behaviour and still not exist.
 *
 * Two properties are asserted throughout rather than once, because they are the
 * reasons this command has the shape it has:
 *
 * - **An argument the client can judge is judged before any socket opens.** The
 *   stub records every request it is given, so "no request was made" is an
 *   assertion and not an assumption.
 * - **No invite code passes through the command, in either direction.** It is
 *   not accepted as an argument and it is not echoed into the output, so
 *   nothing puts a live bearer credential into a shell history or a scrollback
 *   in the course of destroying it.
 *
 * @module
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Transport, TransportRequest, TransportResponse } from '@agentchat/client';
import { InMemoryCredentialStore } from '@agentchat/client';
import { ErrorCode, errorEnvelope, InviteId, ProjectId, UserId } from '@agentchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { CliError } from '../errors.js';
import { captureRun } from '../testing.js';
import { PROGRAM } from '../version.js';
import { requireInviteId } from './invite.js';
import type { ProjectOverrides } from './project.js';
import { createProjectCommand } from './project.js';

const SERVER = 'https://chat.example.test';

const USER = UserId.generate();
const PROJECT = ProjectId.generate();
const OTHER_PROJECT = ProjectId.generate();
const INVITE = InviteId.generate();

/** A live bearer credential, which this command must never accept or print. */
const CODE = 'ANET-7K4M-Q2P9';

const LIST_PROJECTS = 'GET /projects';
const REVOKE = `DELETE /projects/${PROJECT}/invites/${INVITE}`;

/** The project the fixtures act in, as `GET /projects` reports it. */
const MEMBERSHIP = {
  id: PROJECT,
  slug: 'payments',
  name: 'Payments Platform',
  createdBy: USER,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'member',
};

/** One scripted response. */
interface Reply {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * A transport that answers from a script instead of a socket.
 *
 * The last reply for a route repeats, which is what makes revoking twice one
 * entry rather than two.
 */
class StubServer implements Transport {
  public readonly calls: TransportRequest[] = [];
  readonly #queues = new Map<string, Reply[]>();

  public on(key: string, ...replies: readonly Reply[]): this {
    this.#queues.set(key, [...replies]);
    return this;
  }

  public get keys(): readonly string[] {
    return this.calls.map((call) => `${call.method} ${call.path}`);
  }

  public countOf(key: string): number {
    return this.keys.filter((seen) => seen === key).length;
  }

  public request(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    const key = `${request.method} ${request.path}`;
    const queue = this.#queues.get(key);
    const next = queue === undefined || queue.length === 0 ? undefined : queue[0];
    if (next === undefined) {
      return Promise.resolve({
        status: 404,
        headers: {},
        body: errorEnvelope(ErrorCode.NOT_FOUND, `No stub for ${key}.`),
      });
    }
    if (queue !== undefined && queue.length > 1) {
      queue.shift();
    }
    return Promise.resolve({ status: next.status, headers: {}, body: next.body ?? {} });
  }
}

/**
 * A stub that knows the caller's projects and answers the revocation.
 *
 * @returns The stub.
 */
function revocable(): StubServer {
  return new StubServer()
    .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } })
    .on(REVOKE, { status: 200, body: {} });
}

/**
 * A store that is logged in, so `auth: 'required'` calls reach the transport.
 *
 * @returns The store.
 */
function signedIn(): InMemoryCredentialStore {
  return new InMemoryCredentialStore({
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
  });
}

const temporaries: string[] = [];

/**
 * A throwaway directory.
 *
 * @returns Its absolute path.
 */
async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agentchat-invite-'));
  temporaries.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** What one in-process invocation produced. */
interface Outcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/**
 * Runs one `project` subcommand through the whole framework.
 *
 * @param argv - The arguments after `project`.
 * @param overrides - The seams to run against.
 * @param env - Extra environment, merged over the defaults.
 * @returns Both streams and the exit code.
 */
async function runProject(
  argv: readonly string[],
  overrides: ProjectOverrides,
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Outcome> {
  return await captureRun(['project', ...argv, '--server', SERVER], {
    commands: [createProjectCommand(overrides)],
    env: {
      XDG_CONFIG_HOME: await temporaryDirectory(),
      AGENTCHAT_PROJECT: PROJECT,
      ...env,
    },
    cwd: await temporaryDirectory(),
  });
}

describe('requireInviteId', () => {
  it('accepts an invite identifier, trimming it', () => {
    expect(requireInviteId(` ${INVITE} `)).toBe(INVITE);
  });

  it('rejects an invite code, and says in the hint why a code is not accepted', () => {
    expect(() => requireInviteId(CODE)).toThrow(/not an invite identifier/);

    let hint = '';
    try {
      requireInviteId(CODE);
    } catch (error) {
      hint = error instanceof CliError ? (error.hint ?? '') : '';
    }
    expect(hint).toContain('shell history');
    expect(hint).toContain(`${PROGRAM} project invite`);
  });

  it('rejects another kind of identifier in the invite position', () => {
    expect(() => requireInviteId(PROJECT)).toThrow(/not an invite identifier/);
  });
});

describe('project revoke-invite', () => {
  it('revokes by identifier and reports it on stdout', async () => {
    const stub = revocable();

    const run = await runProject(['revoke-invite', INVITE], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(0);
    expect(stub.countOf(REVOKE)).toBe(1);
    expect(run.stdout).toContain(INVITE);
    expect(run.stdout).toContain('Revoked');
    expect(run.stderr).toBe('');
  });

  it('emits the documented shape under --json, and no code', async () => {
    const stub = revocable();

    const run = await runProject(
      ['revoke-invite', INVITE, '--project', 'payments', '--json'],
      { store: signedIn(), transport: stub },
      { AGENTCHAT_PROJECT: undefined },
    );

    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      invite: { id: INVITE },
      project: { id: PROJECT, slug: 'payments' },
      revoked: true,
    });
  });

  it('never puts an invite code in the output', async () => {
    const stub = revocable();

    const run = await runProject(['revoke-invite', INVITE], {
      store: signedIn(),
      transport: stub,
    });

    expect(`${run.stdout}${run.stderr}`).not.toContain(CODE);
  });

  it('turns a slug from --project into an id before asking', async () => {
    const stub = revocable();

    await runProject(
      ['revoke-invite', INVITE, '--project', 'payments'],
      { store: signedIn(), transport: stub },
      { AGENTCHAT_PROJECT: undefined },
    );

    expect(stub.keys).toEqual([LIST_PROJECTS, REVOKE]);
  });

  it('refuses an invite code as the argument, before opening a socket', async () => {
    const stub = revocable();

    const run = await runProject(['revoke-invite', CODE], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(2);
    expect(stub.calls).toEqual([]);
    expect(run.stderr).toContain('not an invite identifier');
    expect(run.stdout).toBe('');
  });

  it('refuses a project id in the invite position, before opening a socket', async () => {
    const stub = revocable();

    const run = await runProject(['revoke-invite', OTHER_PROJECT], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(2);
    expect(stub.calls).toEqual([]);
    expect(run.stdout).toBe('');
  });

  it('asks for the identifier when none was given', async () => {
    const stub = revocable();

    const run = await runProject(['revoke-invite'], { store: signedIn(), transport: stub });

    expect(run.code).toBe(2);
    expect(stub.calls).toEqual([]);
    expect(run.stderr).toContain('needs 1 argument');
    expect(run.stderr).toContain('project revoke-invite <inv_…>');
  });

  // T-014 decided revocation is idempotent: the caller's intent is already
  // satisfied, and a retry over a flaky connection is not an error. The stub
  // answers `200 {}` every time, as the server does.
  it('succeeds again when the invite is already revoked', async () => {
    const stub = revocable();
    const seams = { store: signedIn(), transport: stub };

    const first = await runProject(['revoke-invite', INVITE, '--json'], seams);
    const second = await runProject(['revoke-invite', INVITE, '--json'], seams);

    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout)).toEqual(JSON.parse(first.stdout));
    expect(stub.countOf(REVOKE)).toBe(2);
  });

  it('reports an identifier the project does not have as a failure', async () => {
    const stub = new StubServer()
      .on(LIST_PROJECTS, { status: 200, body: { items: [MEMBERSHIP] } })
      .on(REVOKE, {
        status: 404,
        body: errorEnvelope(ErrorCode.NOT_FOUND, 'No such invite.'),
      });

    const run = await runProject(['revoke-invite', INVITE], {
      store: signedIn(),
      transport: stub,
    });

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('No such invite.');
    expect(run.stdout).toBe('');
  });

  it('fails when the caller is not in the project the slug names', async () => {
    const stub = revocable();

    const run = await runProject(
      ['revoke-invite', INVITE, '--project', 'billing'],
      { store: signedIn(), transport: stub },
      { AGENTCHAT_PROJECT: undefined },
    );

    expect(run.code).toBe(1);
    expect(run.stderr).toContain('not in a project with the slug `billing`');
    expect(stub.countOf(REVOKE)).toBe(0);
  });
});
