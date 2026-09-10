import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentId, ErrorCode, ProjectId } from '@stackgrid/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { Args, GLOBAL_OPTION_ENV } from './args.js';
import type { CommandContext } from './command.js';
import {
  BUILT_IN_SERVER_URL,
  defaultAgentFor,
  EMPTY_USER_CONFIG,
  findRepositoryConfig,
  parseRepositoryConfig,
  readUserConfig,
  rememberServerUrl,
  repositoryConfigPath,
  requireServer,
  resolveServer,
  SERVER_ENV,
  serverRequestFor,
  userConfigDir,
  userConfigPath,
  withDefaultAgent,
  withoutDefaultAgent,
  writeRepositoryConfig,
  writeUserConfig,
} from './config.js';
import { CliError, UsageError } from './errors.js';

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

/**
 * What `parseArgs` puts in an `Args`. Spelled out here because `args.ts` keeps
 * its own name for this private, and that file belongs to another task.
 */
type ParsedOptionValue = string | boolean | (string | boolean)[] | undefined;

/**
 * A command context carrying only the two things {@link serverRequestFor} reads.
 *
 * The rest of the interface is streams, a logger and an abort signal, none of
 * which resolution touches; supplying real ones would be a fixture proving
 * nothing. The cast is the narrow, stated exception rather than a habit.
 *
 * @param values - Parsed option values, as `parseArgs` would produce them. An
 *   array is an option that was given more than once.
 * @param env - The environment the context reports.
 * @returns Something a resolver can be handed.
 */
function contextWith(
  values: Readonly<Record<string, ParsedOptionValue>>,
  env: Readonly<Record<string, string | undefined>>,
): CommandContext {
  return { args: new Args(values, [], env), env: { env } } as unknown as CommandContext;
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

  it('ignores an XDG_CONFIG_HOME that is relative or empty', () => {
    // The XDG specification calls a relative value invalid and says to ignore
    // it. Honouring it would resolve the directory against whatever the process
    // happened to be run in, so the same account would have a different
    // configuration in every repository.
    expect(userConfigDir({ HOME: '/home/alice', XDG_CONFIG_HOME: 'cfg' })).toBe(
      '/home/alice/.config/agentchat',
    );
    expect(userConfigDir({ HOME: '/home/alice', XDG_CONFIG_HOME: '' })).toBe(
      '/home/alice/.config/agentchat',
    );
  });

  it('resolves the home directory from the environment it was given', () => {
    // `USERPROFILE` is the Windows spelling, and `os.homedir()` is only the
    // last resort: an environment handed to this function was handed to it on
    // purpose, and reading the process's own home instead is precisely how this
    // function and the credential store came to disagree (T-209).
    expect(userConfigDir({ HOME: '/fixture/home' })).toBe('/fixture/home/.config/agentchat');
    expect(userConfigDir({ USERPROFILE: '/fixture/home' })).toBe('/fixture/home/.config/agentchat');
    expect(userConfigDir({ HOME: '/fixture/home', USERPROFILE: '/other' })).toBe(
      '/fixture/home/.config/agentchat',
    );
  });

  it('lets an explicit home override the environment', () => {
    expect(userConfigDir({ HOME: '/fixture/home' }, '/home/alice')).toBe(
      '/home/alice/.config/agentchat',
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

describe('resolving the server URL', () => {
  it('agrees with the argument parser about the variable name', () => {
    // Two constants that must say the same thing, on the bargain `version.ts`
    // makes with `package.json`: the duplication is allowed because this fails
    // the build the moment it stops being true. The help line and the resolver
    // would otherwise name different variables and nothing would say so.
    expect(SERVER_ENV).toBe(GLOBAL_OPTION_ENV['server']);
  });

  it('prefers the flag to everything else', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home, [SERVER_ENV]: 'https://variable.example' };
    await writeUserConfig(env, { ...EMPTY_USER_CONFIG, serverUrl: 'https://stored.example' });

    await expect(resolveServer({ env, serverFlag: 'https://flag.example' })).resolves.toEqual({
      url: 'https://flag.example',
      source: 'flag',
      origin: '--server',
    });
  });

  it('prefers the variable to the stored configuration', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home, [SERVER_ENV]: 'https://variable.example' };
    await writeUserConfig(env, { ...EMPTY_USER_CONFIG, serverUrl: 'https://stored.example' });

    await expect(resolveServer({ env })).resolves.toEqual({
      url: 'https://variable.example',
      source: 'environment',
      origin: SERVER_ENV,
    });
  });

  it('falls back to the stored configuration, naming the file it read', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await writeUserConfig(env, { ...EMPTY_USER_CONFIG, serverUrl: 'https://stored.example' });

    await expect(resolveServer({ env })).resolves.toEqual({
      url: 'https://stored.example',
      source: 'user-config',
      origin: userConfigPath(env),
    });
  });

  it('reads no file when the caller has already read one', async () => {
    // `agentchat status` resolves the server and the default agent from one
    // read. Passing a configuration that disagrees with the one on disk is the
    // only way to prove the file was not consulted a second time.
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await writeUserConfig(env, { ...EMPTY_USER_CONFIG, serverUrl: 'https://on-disk.example' });

    const resolved = await resolveServer({
      env,
      userConfig: { ...EMPTY_USER_CONFIG, serverUrl: 'https://supplied.example' },
    });

    expect(resolved.url).toBe('https://supplied.example');
  });

  it('falls back to the built-in server last, and this build has none', async () => {
    // The assertion that matters to a *user* is the second one. The first is
    // what makes the fourth step real rather than dead code: change the
    // constant and the step answers, which is exactly the one-line edit plan
    // §8 M5 ("Set `serverUrl` default in the CLI build") is scheduled to make.
    const env = { XDG_CONFIG_HOME: await scratch() };

    expect(BUILT_IN_SERVER_URL).toBeNull();
    await expect(resolveServer({ env })).resolves.toEqual({
      url: null,
      source: null,
      origin: null,
    });
  });

  it('treats an empty or blank value as no value at all', async () => {
    // `AGENTCHAT_SERVER="$SOME_UNSET_THING"` is an empty string, not an absent
    // key, and reporting `Expected an absolute server URL, got ""` for it sends
    // the reader looking for a malformed URL rather than a missing one.
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home, [SERVER_ENV]: '   ' };

    await expect(resolveServer({ env, serverFlag: '' })).resolves.toEqual({
      url: null,
      source: null,
      origin: null,
    });
  });

  it('trims a value that survived a shell with a space in it', async () => {
    // The old `login` trimmed and the old `status` did not, so this exact input
    // was accepted by one command and rejected by the other. One resolver, one
    // answer.
    const env = { XDG_CONFIG_HOME: await scratch() };

    await expect(
      resolveServer({ env, serverFlag: '  https://chat.example.com  ' }),
    ).resolves.toEqual({ url: 'https://chat.example.com', source: 'flag', origin: '--server' });
  });

  it('does not validate what it resolves, so status can report a typo', async () => {
    const env = { XDG_CONFIG_HOME: await scratch(), [SERVER_ENV]: 'chat.example.com' };

    await expect(resolveServer({ env })).resolves.toMatchObject({
      url: 'chat.example.com',
      source: 'environment',
    });
  });
});

describe('requiring a server URL', () => {
  it('normalises what it returns, and keeps the provenance', async () => {
    const env = { XDG_CONFIG_HOME: await scratch() };

    await expect(requireServer({ env, serverFlag: 'https://chat.example.com/' })).resolves.toEqual({
      url: 'https://chat.example.com',
      source: 'flag',
      origin: '--server',
    });
  });

  it('rejects a value that is not an absolute http URL', async () => {
    const env = { XDG_CONFIG_HOME: await scratch() };

    await expect(requireServer({ env, serverFlag: 'ftp://chat.example.com' })).rejects.toThrow(
      /http or https/,
    );
  });

  it('tells a fresh installation how to obtain an address, not how to spell a flag', async () => {
    // The message this replaced named `--server`, `AGENTCHAT_SERVER` and a JSON
    // key, which is the wrong half of the problem: a new user is not stuck on
    // the syntax, they are stuck on not knowing the address. So the assertions
    // are about the three things they do not know — who has the address, that
    // supplying it once is enough, and where it ends up.
    const env = { XDG_CONFIG_HOME: await scratch() };

    const error = await requireServer({ env }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(UsageError);
    const hint = (error as UsageError).hint ?? '';
    expect(hint).toContain('agentchat login --server <url>');
    expect(hint).toContain('ask whoever runs it');
    expect(hint).toContain('once');
    expect(hint).toContain(userConfigPath(env));
  });
});

describe('recording the server a login succeeded against', () => {
  it('writes it, so the next command needs no flag', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };

    const written = await rememberServerUrl(env, {
      url: 'https://chat.example.com',
      source: 'flag',
      origin: '--server',
    });

    expect(written).toBe(userConfigPath(env));
    await expect(resolveServer({ env })).resolves.toEqual({
      url: 'https://chat.example.com',
      source: 'user-config',
      origin: userConfigPath(env),
    });
  });

  it('records a server that came from the variable too', async () => {
    // `AGENTCHAT_SERVER=… agentchat login` leaves this machine holding that
    // server's tokens. A configuration that stayed silent about it would answer
    // "no server is configured" in the next shell, while the credentials file
    // says otherwise.
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };

    await rememberServerUrl(env, {
      url: 'https://variable.example',
      source: 'environment',
      origin: SERVER_ENV,
    });

    expect((await readUserConfig(env)).serverUrl).toBe('https://variable.example');
  });

  it('overwrites a different server rather than leaving a stale one', async () => {
    // The credentials file has just been replaced with the new server's tokens.
    // A configuration still naming the old one would point every later command
    // at a host guaranteed to reject them.
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await writeUserConfig(env, { ...EMPTY_USER_CONFIG, serverUrl: 'https://old.example' });

    await rememberServerUrl(env, {
      url: 'https://new.example',
      source: 'flag',
      origin: '--server',
    });

    expect((await readUserConfig(env)).serverUrl).toBe('https://new.example');
  });

  it('keeps the default agents it did not come to change', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await writeUserConfig(env, withDefaultAgent(EMPTY_USER_CONFIG, PROJECT, AGENT));

    await rememberServerUrl(env, {
      url: 'https://chat.example.com',
      source: 'flag',
      origin: '--server',
    });

    expect(defaultAgentFor(await readUserConfig(env), PROJECT)).toBe(AGENT);
  });

  it('writes nothing when the server is already the one recorded', async () => {
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };
    await writeUserConfig(env, { ...EMPTY_USER_CONFIG, serverUrl: 'https://chat.example.com' });

    await expect(
      rememberServerUrl(env, {
        url: 'https://chat.example.com',
        source: 'user-config',
        origin: userConfigPath(env),
      }),
    ).resolves.toBeNull();
  });

  it('never records a built-in default', async () => {
    // Writing it down would pin this user to whatever their first build shipped
    // with, and make the default unchangeable for anybody who had ever logged
    // in — the opposite of what a default is for.
    const home = await scratch();
    const env = { XDG_CONFIG_HOME: home };

    const written = await rememberServerUrl(env, {
      url: 'https://built-in.example',
      source: 'built-in',
      origin: 'built in to agentchat 0.1.0',
    });

    expect(written).toBeNull();
    expect((await readUserConfig(env)).serverUrl).toBeNull();
  });
});

describe('building a server request from a command', () => {
  it('separates the flag from the variable, so the origin is a fact', () => {
    // `Args.value` merges the two and cannot say which answered. Reporting
    // `--server` for a URL that came from the environment would send somebody
    // hunting through a command line that never had it.
    const env = { [SERVER_ENV]: 'https://variable.example' };

    const fromVariable = serverRequestFor(contextWith({}, env));
    const fromFlag = serverRequestFor(contextWith({ server: 'https://flag.example' }, env));

    expect(fromVariable.serverFlag).toBeUndefined();
    expect(fromFlag.serverFlag).toBe('https://flag.example');
    expect(fromVariable.env).toBe(env);
  });

  it('still rejects a `--server` given twice', () => {
    // The duplicate check lives in `Args.value`, and the flag is read from
    // `Args.list`. Nothing else calls `value('server')` any more, so this is
    // what keeps T-027's check alive on this option.
    expect(() =>
      serverRequestFor(contextWith({ server: ['https://a.example', 'https://b.example'] }, {})),
    ).toThrow(UsageError);
  });

  it('passes a user configuration through without reading a file', async () => {
    const supplied = { ...EMPTY_USER_CONFIG, serverUrl: 'https://supplied.example' };

    const request = serverRequestFor(contextWith({}, { XDG_CONFIG_HOME: await scratch() }), {
      userConfig: supplied,
    });

    expect(request.userConfig).toBe(supplied);
  });
});
