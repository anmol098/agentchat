import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TransportError } from '@stackgrid/client';
import { AgentId, ErrorCode, ProjectId } from '@stackgrid/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { Command } from './command.js';
import type { UserConfig } from './config.js';
import {
  EMPTY_USER_CONFIG,
  withDefaultAgent,
  writeRepositoryConfig,
  writeUserConfig,
} from './config.js';
import type { AgentIdentity, ContextRequest, OwnAgentLookup } from './context.js';
import {
  AGENT_ENV,
  CONTEXT_OPTIONS,
  contextRequestFor,
  PROJECT_ENV,
  resolveAgent,
  resolveContext,
  resolveProject,
} from './context.js';
import { CliError, describeFailure, UsageError } from './errors.js';
import { ExitCode } from './exit.js';
import { view } from './output/output.js';
import { captureRun } from './testing.js';

const PROJECT = ProjectId.unsafeCast('prj_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b');
const OTHER_PROJECT = ProjectId.unsafeCast('prj_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2c');
const AGENT = AgentId.unsafeCast('agt_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b');

const temporaries: string[] = [];

/**
 * Makes a temporary directory, removed after the test.
 *
 * @returns Its absolute path.
 */
async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agentchat-context-'));
  temporaries.push(path);
  return path;
}

/**
 * A repository with `.agentchat/config.json` at its root and a nested
 * directory to run commands from.
 *
 * @returns The root and a directory several levels below it.
 */
async function repository(): Promise<{ root: string; nested: string }> {
  const root = await scratch();
  await writeRepositoryConfig(root, { projectId: PROJECT, projectSlug: 'payments' });
  const nested = join(root, 'services', 'billing', 'src');
  await mkdir(nested, { recursive: true });
  return { root, nested };
}

/**
 * A lookup that answers with a fixed set of agents.
 *
 * @param agents - What the server would say.
 * @returns The lookup.
 */
function lookupOf(agents: readonly AgentIdentity[]): OwnAgentLookup {
  return async () => await Promise.resolve(agents);
}

/**
 * Builds a request with an empty environment and no lookup.
 *
 * @param overrides - What this test cares about.
 * @returns The request.
 */
function request(overrides: Partial<ContextRequest> & { cwd: string }): ContextRequest {
  return { env: {}, userConfig: EMPTY_USER_CONFIG, ...overrides };
}

/**
 * Catches whatever a resolution threw.
 *
 * @param promise - The resolution.
 * @returns The thrown value.
 */
async function failure(promise: Promise<unknown>): Promise<CliError> {
  const thrown = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(thrown).toBeInstanceOf(CliError);
  return thrown as CliError;
}

afterEach(async () => {
  await Promise.all(
    temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('project resolution', () => {
  it('walks up from a nested directory to the repository configuration', async () => {
    const { root, nested } = await repository();

    const project = await resolveProject(request({ cwd: nested }));

    expect(project.id).toBe(PROJECT);
    expect(project.slug).toBe('payments');
    expect(project.source).toBe('repository');
    expect(project.configPath).toBe(join(root, '.agentchat', 'config.json'));
  });

  it('lets the flag override both the environment and the repository', async () => {
    const { nested } = await repository();

    const project = await resolveProject(
      request({
        cwd: nested,
        projectFlag: 'checkout',
        env: { [PROJECT_ENV]: 'billing' },
      }),
    );

    expect(project.slug).toBe('checkout');
    expect(project.id).toBeNull();
    expect(project.source).toBe('flag');
  });

  it('lets the environment override the repository', async () => {
    const { nested } = await repository();

    const project = await resolveProject(
      request({ cwd: nested, env: { [PROJECT_ENV]: OTHER_PROJECT } }),
    );

    expect(project.id).toBe(OTHER_PROJECT);
    expect(project.source).toBe('environment');
    expect(project.origin).toBe(PROJECT_ENV);
  });

  it('treats an empty environment variable as unset', async () => {
    // `export AGENTCHAT_PROJECT=` is how a shell clears one, and a harness that
    // interpolates a possibly-empty value should behave as if it had not.
    const { nested } = await repository();

    const project = await resolveProject(request({ cwd: nested, env: { [PROJECT_ENV]: '  ' } }));

    expect(project.source).toBe('repository');
  });

  it('rejects an empty flag rather than resolving something else', async () => {
    const { nested } = await repository();

    await expect(resolveProject(request({ cwd: nested, projectFlag: '' }))).rejects.toBeInstanceOf(
      UsageError,
    );
  });

  it('rejects a value that is neither an id nor a slug, as a usage error', async () => {
    const cwd = await scratch();

    const error = await failure(resolveProject(request({ cwd, projectFlag: 'Payments Ltd' })));

    expect(describeFailure(error).exit).toBe(ExitCode.USAGE);
    expect(error.message).toContain('"Payments Ltd"');
  });

  it('fails with the command that fixes it when nothing resolves', async () => {
    const cwd = await scratch();

    const error = await failure(resolveProject(request({ cwd })));

    expect(error.code).toBe(ErrorCode.NO_PROJECT);
    expect(describeFailure(error).exit).toBe(ExitCode.NO_CONTEXT);
    expect(error.message).toContain('agentchat project init <slug>');
    expect(error.message).toContain(cwd);
    expect(error.hint).toContain('--project <slug>');
    expect(error.hint).toContain(PROJECT_ENV);
  });
});

describe('agent resolution', () => {
  /** The project every agent test resolves against. */
  const project = {
    id: PROJECT,
    slug: 'payments',
    source: 'repository',
    origin: '/repo/.agentchat/config.json',
    configPath: '/repo/.agentchat/config.json',
  } as const;

  it('prefers the flag to everything else', async () => {
    const userConfig = withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT);

    const agent = await resolveAgent(project, {
      cwd: '/repo',
      env: { [AGENT_ENV]: 'from-env' },
      agentFlag: 'backend',
      userConfig,
      agents: lookupOf([{ id: AGENT, name: 'only' }]),
    });

    expect(agent.name).toBe('backend');
    expect(agent.source).toBe('flag');
  });

  it('prefers the environment to the stored default', async () => {
    const userConfig = withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT);

    const agent = await resolveAgent(project, {
      cwd: '/repo',
      env: { [AGENT_ENV]: 'frontend' },
      userConfig,
    });

    expect(agent.name).toBe('frontend');
    expect(agent.source).toBe('environment');
  });

  it('uses the per-project default from user configuration', async () => {
    const userConfig = withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT);

    const agent = await resolveAgent(project, { cwd: '/repo', env: {}, userConfig });

    expect(agent.id).toBe(AGENT);
    expect(agent.source).toBe('user-config');
  });

  it('does not use another project default for this project', async () => {
    const userConfig = withDefaultAgent(EMPTY_USER_CONFIG, OTHER_PROJECT, AGENT);

    const error = await failure(resolveAgent(project, { cwd: '/repo', env: {}, userConfig }));

    expect(error.code).toBe(ErrorCode.NO_AGENT);
  });

  it('reads the user configuration from disk when the caller did not', async () => {
    // The default lives in *user* configuration, never in the repository: two
    // developers cloning the same project must not inherit each other's agent.
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await writeUserConfig(env, withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT));

    const agent = await resolveAgent(project, { cwd: '/repo', env });

    expect(agent.id).toBe(AGENT);
  });

  it('takes the only agent in the project when there is exactly one', async () => {
    const agent = await resolveAgent(project, {
      cwd: '/repo',
      env: {},
      userConfig: EMPTY_USER_CONFIG,
      agents: lookupOf([{ id: AGENT, name: 'backend' }]),
    });

    expect(agent.id).toBe(AGENT);
    expect(agent.name).toBe('backend');
    expect(agent.source).toBe('only-agent');
  });

  it('lists the candidates when there is more than one', async () => {
    const error = await failure(
      resolveAgent(project, {
        cwd: '/repo',
        env: {},
        userConfig: EMPTY_USER_CONFIG,
        agents: lookupOf([
          { id: AGENT, name: 'backend' },
          { id: AgentId.unsafeCast('agt_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2c'), name: 'frontend' },
        ]),
      }),
    );

    expect(error.code).toBe(ErrorCode.NO_AGENT);
    expect(error.message).toContain('backend, frontend');
    expect(error.message).toContain('agentchat agent use backend');
  });

  it('says to create one when the caller has none here', async () => {
    const error = await failure(
      resolveAgent(project, {
        cwd: '/repo',
        env: {},
        userConfig: EMPTY_USER_CONFIG,
        agents: lookupOf([]),
      }),
    );

    expect(error.message).toContain('agentchat agent create <name>');
  });

  it('never reaches the network unless a lookup is supplied', async () => {
    // The decision this module makes explicit: resolution is local, and the
    // one rule that cannot be is opt-in per command.
    const error = await failure(
      resolveAgent(project, { cwd: '/repo', env: {}, userConfig: EMPTY_USER_CONFIG }),
    );

    expect(error.code).toBe(ErrorCode.NO_AGENT);
    expect(error.message).toContain('agentchat agent use <name>');
  });

  it('reports the missing agent, not the missing network, when offline', async () => {
    const error = await failure(
      resolveAgent(project, {
        cwd: '/repo',
        env: {},
        userConfig: EMPTY_USER_CONFIG,
        agents: () => Promise.reject(new TransportError('connect ECONNREFUSED')),
      }),
    );

    expect(error.code).toBe(ErrorCode.NO_AGENT);
    expect(describeFailure(error).exit).toBe(ExitCode.NO_CONTEXT);
    expect(error.message).toContain('could not be reached');
    expect(error.message).toContain('agentchat agent use <name>');
    expect(error.cause).toBeInstanceOf(TransportError);
  });

  it('lets a failure with its own remedy through untouched', async () => {
    // An expired login is not a context problem. Turning it into `NO_AGENT`
    // would send the user to `agent use`, which would fail the same way.
    const authRequired = new CliError(ErrorCode.AUTH_REQUIRED, 'Your session has expired.');

    await expect(
      resolveAgent(project, {
        cwd: '/repo',
        env: {},
        userConfig: EMPTY_USER_CONFIG,
        agents: () => Promise.reject(authRequired),
      }),
    ).rejects.toBe(authRequired);
  });

  it('skips the stored default when only a slug is known', async () => {
    // `--project payments` does not say which id that is, so there is nothing
    // to look the default up by. The shortcut has to answer instead.
    const bySlug = {
      id: null,
      slug: 'payments',
      source: 'flag',
      origin: '--project',
      configPath: null,
    } as const;
    const userConfig: UserConfig = withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT);

    const agent = await resolveAgent(bySlug, {
      cwd: '/repo',
      env: {},
      userConfig,
      agents: lookupOf([{ id: AGENT, name: 'backend' }]),
    });

    expect(agent.source).toBe('only-agent');
  });

  it('accepts an agent id as well as a name', async () => {
    const agent = await resolveAgent(project, { cwd: '/repo', env: {}, agentFlag: AGENT });

    expect(agent.id).toBe(AGENT);
    expect(agent.name).toBeNull();
  });

  it('rejects a handle where a bare agent name belongs', async () => {
    const error = await failure(
      resolveAgent(project, { cwd: '/repo', env: {}, agentFlag: '@alice/backend' }),
    );

    expect(describeFailure(error).exit).toBe(ExitCode.USAGE);
    expect(error.hint).toContain('--agent backend');
  });
});

describe('resolveContext', () => {
  it('resolves both halves from a nested directory and user configuration', async () => {
    const { nested } = await repository();
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await writeUserConfig(env, withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT));

    const context = await resolveContext({ cwd: nested, env });

    expect(context.project.id).toBe(PROJECT);
    expect(context.agent.id).toBe(AGENT);
  });

  it('fails on the project before it asks about the agent', async () => {
    const cwd = await scratch();

    const error = await failure(resolveContext({ cwd, env: {} }));

    expect(error.code).toBe(ErrorCode.NO_PROJECT);
  });
});

describe('a command resolving its own context', () => {
  /**
   * A command that does nothing but resolve and report, so the whole path —
   * flag declaration, parsing, resolution, error rendering, exit code — is
   * exercised the way T-207 to T-209 will use it.
   */
  const probe: Command = {
    kind: 'command',
    name: 'probe',
    summary: 'resolve the context and print it',
    options: CONTEXT_OPTIONS,
    async run(context) {
      const resolved = await resolveContext(contextRequestFor(context));
      await context.emit(
        view({ project: resolved.project.id, agent: resolved.agent.source }, (writer) => {
          writer.fields([['project', resolved.project.id]]);
        }),
      );
    },
  };

  it('reads the flags the command declared', async () => {
    const { nested } = await repository();
    const home = await scratch();
    await writeUserConfig(
      { XDG_CONFIG_HOME: home },
      withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT),
    );

    const capture = await captureRun(['probe', '--json', '--agent', 'backend'], {
      commands: [probe],
      cwd: nested,
      env: { XDG_CONFIG_HOME: home },
    });

    expect(capture.code).toBe(ExitCode.OK);
    expect(JSON.parse(capture.stdout)).toEqual({ project: PROJECT, agent: 'flag' });
  });

  it('exits 4 with an actionable envelope when there is no project', async () => {
    // The contract a harness branches on: code 4, and a JSON error carrying the
    // command to run. Nothing on stdout but that one line.
    const cwd = await scratch();

    const capture = await captureRun(['probe', '--json'], { commands: [probe], cwd, env: {} });

    expect(capture.code).toBe(ExitCode.NO_CONTEXT);
    const { error } = JSON.parse(capture.stdout) as {
      error: { code: string; message: string; hint: string };
    };
    expect(error.code).toBe('NO_PROJECT');
    expect(error.message).toContain('agentchat project init <slug>');
  });

  it('exits 4 naming `agent use` when the project resolves but the agent does not', async () => {
    const { nested } = await repository();
    const home = await scratch();

    const capture = await captureRun(['probe'], {
      commands: [probe],
      cwd: nested,
      env: { XDG_CONFIG_HOME: home },
    });

    expect(capture.code).toBe(ExitCode.NO_CONTEXT);
    expect(capture.stdout).toBe('');
    expect(capture.stderr).toContain('agentchat agent use <name>');
    expect(capture.stderr).toContain('NO_AGENT');
  });
});

describe('CONTEXT_OPTIONS', () => {
  it('names the environment variable in each flag description', () => {
    // The help text is where a user learns the fallback exists; plan §6.1
    // documents both and neither is discoverable otherwise.
    expect(CONTEXT_OPTIONS['project']?.description).toContain(PROJECT_ENV);
    expect(CONTEXT_OPTIONS['agent']?.description).toContain(AGENT_ENV);
  });
});
