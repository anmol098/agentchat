import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentId, ErrorCode, ProjectId } from '@agentchat/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import {
  defaultAgentFor,
  EMPTY_USER_CONFIG,
  findRepositoryConfig,
  parseRepositoryConfig,
  readUserConfig,
  repositoryConfigPath,
  userConfigPath,
  withDefaultAgent,
  withoutDefaultAgent,
  writeRepositoryConfig,
  writeUserConfig,
} from './config.js';
import { CliError } from './errors.js';

const PROJECT = ProjectId.unsafeCast('prj_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b');
const OTHER_PROJECT = ProjectId.unsafeCast('prj_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2c');
const AGENT = AgentId.unsafeCast('agt_018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b');

const temporaries: string[] = [];

/**
 * Makes a temporary directory that is removed when the test file finishes.
 *
 * @returns Its absolute path.
 */
async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'agentchat-config-'));
  temporaries.push(path);
  return path;
}

/**
 * Writes a repository configuration by hand, so a test can put things in it
 * that {@link writeRepositoryConfig} would never produce.
 *
 * @param directory - Where `.agentchat/` should go.
 * @param body - The file's exact contents.
 * @returns The path written.
 */
async function writeRaw(directory: string, body: string): Promise<string> {
  const path = repositoryConfigPath(directory);
  await mkdir(join(directory, '.agentchat'), { recursive: true });
  await writeFile(path, body, 'utf8');
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaries.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('findRepositoryConfig', () => {
  it('finds the configuration in the directory itself', async () => {
    const root = await scratch();
    await writeRepositoryConfig(root, { projectId: PROJECT, projectSlug: 'payments' });

    const found = await findRepositoryConfig(root);

    expect(found?.config.projectId).toBe(PROJECT);
    expect(found?.config.projectSlug).toBe('payments');
    expect(found?.directory).toBe(root);
  });

  it('walks up from a nested working directory', async () => {
    // The case the whole mechanism exists for: an agent running in
    // packages/server/src still knows which project it is in.
    const root = await scratch();
    await writeRepositoryConfig(root, { projectId: PROJECT, projectSlug: 'payments' });
    const nested = join(root, 'packages', 'server', 'src', 'routes');
    await mkdir(nested, { recursive: true });

    const found = await findRepositoryConfig(nested);

    expect(found?.config.projectId).toBe(PROJECT);
    expect(found?.directory).toBe(root);
  });

  it('prefers the nearest configuration to one further up', async () => {
    const root = await scratch();
    await writeRepositoryConfig(root, { projectId: PROJECT, projectSlug: 'outer' });
    const inner = join(root, 'vendor', 'inner');
    await mkdir(inner, { recursive: true });
    await writeRepositoryConfig(inner, { projectId: OTHER_PROJECT, projectSlug: 'inner' });

    const found = await findRepositoryConfig(join(inner, 'src'));

    expect(found?.config.projectId).toBe(OTHER_PROJECT);
  });

  it('terminates at the filesystem root when there is nothing to find', async () => {
    // The termination proof, run rather than argued: a deep path under a
    // directory with no configuration anywhere above it must answer, not hang.
    const root = await scratch();
    const deep = join(root, ...Array.from({ length: 40 }, (_, index) => `d${String(index)}`));
    await mkdir(deep, { recursive: true });

    await expect(findRepositoryConfig(deep)).resolves.toBeNull();
  });

  it('fails cleanly when the configuration is a symlink loop', async () => {
    // A path the walk can reach but the filesystem cannot resolve. It must
    // become a message about that file, not an ELOOP escaping as a crash and
    // not a hang.
    const root = await scratch();
    await mkdir(join(root, '.agentchat'), { recursive: true });
    const path = repositoryConfigPath(root);
    await symlink(path, `${path}.tmp`);
    await symlink(`${path}.tmp`, path);

    const error = await findRepositoryConfig(root).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ErrorCode.NO_PROJECT);
    expect((error as CliError).message).toContain(path);
    expect((error as CliError).message).toContain('ELOOP');
  });

  it('treats a file where the directory should be as absent', async () => {
    const root = await scratch();
    await writeFile(join(root, '.agentchat'), 'not a directory', 'utf8');

    await expect(findRepositoryConfig(root)).resolves.toBeNull();
  });
});

describe('parseRepositoryConfig', () => {
  it('names the file and the parser when the JSON is malformed', async () => {
    const root = await scratch();
    const path = await writeRaw(root, '{"projectId": ');

    const error = await findRepositoryConfig(root).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain(path);
    expect((error as CliError).message).toContain('not valid JSON');
    expect((error as CliError).hint).toContain('agentchat project init');
  });

  it('says which field is missing', () => {
    const act = (): unknown => parseRepositoryConfig('{"projectSlug":"payments"}', '/repo/c.json');

    expect(act).toThrow(/`\/repo\/c\.json` is not a usable AgentChat project configuration/);
    expect(act).toThrow(/has no `projectId`/);
  });

  it('says what is wrong with a malformed project id', () => {
    expect(() => parseRepositoryConfig('{"projectId":"payments"}', '/repo/c.json')).toThrow(
      /its `projectId` is "payments", not a project id/,
    );
  });

  it('rejects a document that is not an object', () => {
    expect(() => parseRepositoryConfig('[]', '/repo/c.json')).toThrow(
      /it contains an array, not a JSON object/,
    );
  });

  it('rejects a malformed slug rather than quietly ignoring it', () => {
    expect(() =>
      parseRepositoryConfig(`{"projectId":"${PROJECT}","projectSlug":"Payments Ltd"}`, '/c.json'),
    ).toThrow(/`projectSlug` is "Payments Ltd"/);
  });

  it('ignores unknown ordinary keys so a newer build can add fields', () => {
    const config = parseRepositoryConfig(
      `{"projectId":"${PROJECT}","projectSlug":"payments","defaultConversationStyle":"terse"}`,
      '/c.json',
    );

    expect(config.projectId).toBe(PROJECT);
  });

  it.each([
    [
      'a key that names a credential',
      `{"projectId":"${PROJECT}","refreshToken":"abc"}`,
      'refreshToken',
    ],
    ['a nested credential key', `{"projectId":"${PROJECT}","auth":{"value":"x"}}`, 'auth'],
    [
      'a JWT hiding under an innocent key',
      `{"projectId":"${PROJECT}","note":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl"}`,
      'note',
    ],
    [
      'a GitHub token',
      `{"projectId":"${PROJECT}","note":"ghp_16C7e42F292c6912E7710c838347Ae178B4a"}`,
      'note',
    ],
    [
      'a long opaque value',
      `{"projectId":"${PROJECT}","note":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}`,
      'note',
    ],
  ])('refuses to read %s', (_label, body, location) => {
    // The file is committed. Reading past a secret in it would normalise the
    // leak; refusing is how anybody finds out it is there.
    const act = (): unknown => parseRepositoryConfig(body, '/repo/.agentchat/config.json');

    expect(act).toThrow(new RegExp(`contains \`${location}\``));
    expect(act).toThrow(/committed to the repository/);
    try {
      act();
    } catch (error) {
      expect((error as CliError).code).toBe(ErrorCode.NO_PROJECT);
      expect((error as CliError).hint).toContain('rotate');
    }
  });

  it('does not mistake an AgentChat identifier for a secret', () => {
    // `prj_` plus a UUIDv7 is forty characters of exactly the alphabet the
    // opaque-value rule looks for, and it is the one value this file is for.
    expect(() => parseRepositoryConfig(`{"projectId":"${PROJECT}"}`, '/c.json')).not.toThrow();
  });
});

describe('writeRepositoryConfig', () => {
  it('writes only the project identity, in a form it can read back', async () => {
    const root = await scratch();

    const path = await writeRepositoryConfig(root, { projectId: PROJECT, projectSlug: 'payments' });
    const text = await readFile(path, 'utf8');

    expect(JSON.parse(text)).toEqual({ projectId: PROJECT, projectSlug: 'payments' });
    expect((await findRepositoryConfig(root))?.config.projectSlug).toBe('payments');
  });

  it('omits the slug rather than writing null', async () => {
    const root = await scratch();

    const path = await writeRepositoryConfig(root, { projectId: PROJECT, projectSlug: null });

    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ projectId: PROJECT });
  });
});

describe('user configuration', () => {
  it('puts the file where plan §6.1 says, and honours XDG_CONFIG_HOME', () => {
    expect(userConfigPath({ HOME: '/home/alice' })).toBe(
      '/home/alice/.config/agentchat/config.json',
    );
    expect(userConfigPath({ HOME: '/home/alice', XDG_CONFIG_HOME: '/elsewhere' })).toBe(
      '/elsewhere/agentchat/config.json',
    );
  });

  it('treats a missing file as an empty configuration', async () => {
    const home = await scratch();

    await expect(readUserConfig({ XDG_CONFIG_HOME: home })).resolves.toEqual(EMPTY_USER_CONFIG);
  });

  it('round-trips a default agent, and keeps it out of the repository', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };

    await writeUserConfig(env, withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT));
    const read = await readUserConfig(env);

    expect(defaultAgentFor(read, PROJECT)).toBe(AGENT);
    expect(defaultAgentFor(read, OTHER_PROJECT)).toBeNull();
  });

  it('round-trips a server URL, and drops it again when cleared', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };

    await writeUserConfig(env, { ...EMPTY_USER_CONFIG, serverUrl: 'https://chat.example.com' });
    const stored = await readUserConfig(env);
    await writeUserConfig(env, { ...stored, serverUrl: null });

    expect(stored.serverUrl).toBe('https://chat.example.com');
    expect((await readUserConfig(env)).serverUrl).toBeNull();
  });

  it('refuses a document that is not an object', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await mkdir(join(home, 'agentchat'), { recursive: true });
    await writeFile(userConfigPath(env), '["nope"]', 'utf8');

    await expect(readUserConfig(env)).rejects.toThrow(/not a JSON object/);
  });

  it('writes the file readable only by its owner', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };

    const path = await writeUserConfig(env, EMPTY_USER_CONFIG);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('preserves fields a newer build wrote', async () => {
    // An older `agentchat agent use` must not silently delete a setting a newer
    // one added, because the user would have no way to know it had happened.
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await mkdir(join(home, 'agentchat'), { recursive: true });
    await writeFile(
      userConfigPath(env),
      JSON.stringify({ telemetry: false, defaultAgentByProject: {} }),
      'utf8',
    );

    await writeUserConfig(env, EMPTY_USER_CONFIG);

    expect(JSON.parse(await readFile(userConfigPath(env), 'utf8'))).toMatchObject({
      telemetry: false,
    });
  });

  it('drops entries it cannot understand instead of failing', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await mkdir(join(home, 'agentchat'), { recursive: true });
    await writeFile(
      userConfigPath(env),
      JSON.stringify({ defaultAgentByProject: { [PROJECT]: 'not-an-agent-id', nonsense: AGENT } }),
      'utf8',
    );

    const config = await readUserConfig(env);

    expect(config.defaultAgentByProject).toEqual({});
  });

  it('refuses to run on a corrupt file rather than overwriting it', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await mkdir(join(home, 'agentchat'), { recursive: true });
    await writeFile(userConfigPath(env), '{ oh dear', 'utf8');

    const error = await readUserConfig(env).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain(userConfigPath(env));
    expect((error as CliError).hint).toContain('delete it');
  });
});

describe('default agent helpers', () => {
  it('sets and clears one project without touching another', () => {
    const both = withDefaultAgent(
      withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT),
      OTHER_PROJECT,
      AGENT,
    );

    const cleared = withoutDefaultAgent(both, PROJECT);

    expect(defaultAgentFor(cleared, PROJECT)).toBeNull();
    expect(defaultAgentFor(cleared, OTHER_PROJECT)).toBe(AGENT);
    expect(defaultAgentFor(both, PROJECT)).toBe(AGENT);
  });
});
