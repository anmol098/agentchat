import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ErrorCode } from '@stackgrid/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { userConfigPath } from './config.js';
import {
  CONFIG_DIRECTORY_MODE,
  CREDENTIALS_FILE_MODE,
  createCredentialStore,
  credentialsPath,
  FileCredentialStore,
} from './credentials.js';
import { CliError, causeChain, describeFailure } from './errors.js';
import { ExitCode } from './exit.js';

/**
 * Distinctive token values.
 *
 * Every assertion that a token did not escape looks for this marker, so a leak
 * through a path nobody thought of still trips a test.
 */
const CANARY = 'CANARY-do-not-print-me';
const CREDENTIALS = {
  accessToken: `access-${CANARY}`,
  refreshToken: `refresh-${CANARY}`,
};

/** File modes mean nothing on Windows; the module says so and so do the tests. */
const POSIX = process.platform !== 'win32';

/** `root` bypasses the mode bits, so the tests that rely on them cannot run as it. */
const ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

let directory: string;
let path: string;
let warnings: string[];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'agentchat-T204-'));
  path = join(directory, 'agentchat', 'credentials.json');
  warnings = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  // A test may have made a directory unwritable on purpose.
  await chmod(directory, 0o700).catch(() => {});
  await chmod(join(directory, 'agentchat'), 0o700).catch(() => {});
  await rm(directory, { recursive: true, force: true });
});

/**
 * A store writing into this test's temporary directory.
 *
 * @returns The store under test, with its warnings collected in `warnings`.
 */
function store(): FileCredentialStore {
  return new FileCredentialStore({
    path,
    warn: (message) => warnings.push(message),
  });
}

/**
 * The permission bits of a path.
 *
 * @param target - What to inspect.
 * @returns The low nine bits of its mode.
 */
async function modeOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

/**
 * Puts arbitrary bytes at the credentials path.
 *
 * @param contents - What to write.
 */
async function writeRaw(contents: string): Promise<void> {
  await mkdir(join(directory, 'agentchat'), { recursive: true, mode: 0o700 });
  await writeFile(path, contents, { mode: 0o600 });
}

describe('credentialsPath', () => {
  it('is the path the plan documents', () => {
    expect(credentialsPath({}, '/home/ada')).toBe('/home/ada/.config/agentchat/credentials.json');
  });

  it('honours an absolute XDG_CONFIG_HOME', () => {
    expect(credentialsPath({ XDG_CONFIG_HOME: '/srv/cfg' }, '/home/ada')).toBe(
      '/srv/cfg/agentchat/credentials.json',
    );
  });

  it('ignores a relative XDG_CONFIG_HOME', () => {
    // It would otherwise resolve against whatever directory the command was
    // run in, so `agentchat whoami` would find credentials in one repository
    // and not in the next.
    expect(credentialsPath({ XDG_CONFIG_HOME: 'cfg' }, '/home/ada')).toBe(
      '/home/ada/.config/agentchat/credentials.json',
    );
    expect(credentialsPath({ XDG_CONFIG_HOME: '' }, '/home/ada')).toBe(
      '/home/ada/.config/agentchat/credentials.json',
    );
  });

  it('takes the home directory from the environment it was given', () => {
    // The divergence T-209 found. `credentialsPath` used to default its home to
    // `os.homedir()` and never look at the environment in its hand, so a caller
    // driving the CLI in-process against a fixture read the developer's own
    // credentials while believing it read the fixture's.
    expect(credentialsPath({ HOME: '/fixture/home' })).toBe(
      '/fixture/home/.config/agentchat/credentials.json',
    );
    expect(credentialsPath({ USERPROFILE: '/fixture/home' })).toBe(
      '/fixture/home/.config/agentchat/credentials.json',
    );
  });

  it('lets an explicit home override the environment', () => {
    // Still available for a caller holding a home directory that did not come
    // from `env` at all; it is an override, not a second implementation.
    expect(credentialsPath({ HOME: '/fixture/home' }, '/home/ada')).toBe(
      '/home/ada/.config/agentchat/credentials.json',
    );
  });
});

/**
 * The two resolvers, over identical environments.
 *
 * This is the shape of test T-024 exists for. Both divergences this pair has
 * had — the relative `XDG_CONFIG_HOME` caught by review, and the home directory
 * caught by T-209 — were invisible to a test that called only one of them: each
 * function was self-consistent and correct against its own docs. Only running
 * the pair over the same input showed the tokens and the user configuration
 * going to different directories.
 */
describe('the credentials file and the user config file agree on their directory', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, string | undefined>]> = [
    ['XDG unset', { HOME: '/home/ada' }],
    ['XDG absolute', { HOME: '/home/ada', XDG_CONFIG_HOME: '/srv/cfg' }],
    ['XDG relative', { HOME: '/home/ada', XDG_CONFIG_HOME: 'cfg' }],
    ['XDG empty', { HOME: '/home/ada', XDG_CONFIG_HOME: '' }],
    ['home from USERPROFILE', { USERPROFILE: '/home/ada' }],
    ['nothing set at all', {}],
  ];

  for (const [name, env] of cases) {
    it(`agrees when ${name}`, () => {
      expect(dirname(credentialsPath(env))).toBe(dirname(userConfigPath(env)));
    });
  }

  it('agrees on a supplied environment rather than on the process own', () => {
    // The case that used to fail: with a fixture HOME and no XDG_CONFIG_HOME,
    // the credentials went to the real user's home and the config to the
    // fixture's. Asserted against the literal path as well as against each
    // other, so a future change that breaks *both* the same way is still caught.
    const env = { HOME: '/fixture/home' };
    expect(dirname(credentialsPath(env))).toBe('/fixture/home/.config/agentchat');
    expect(dirname(userConfigPath(env))).toBe('/fixture/home/.config/agentchat');
  });
});

describe('logged out', () => {
  it('loads as null when nothing has ever been saved', async () => {
    // The ordinary case for a fresh machine, and the one the client turns into
    // AUTH_REQUIRED. It must not be a thrown error.
    await expect(store().load()).resolves.toBeNull();
  });

  it('loads as null when the configuration directory does not exist', async () => {
    await expect(
      new FileCredentialStore({ path: join(directory, 'nope', 'x.json') }).load(),
    ).resolves.toBeNull();
  });

  it('clears without complaint when there is nothing to clear', async () => {
    await expect(store().clear()).resolves.toBeUndefined();
    await expect(store().load()).resolves.toBeNull();
  });

  it('loads as null after a clear', async () => {
    const subject = store();
    await subject.save(CREDENTIALS);
    await subject.clear();

    await expect(subject.load()).resolves.toBeNull();
    await expect(stat(path)).rejects.toThrow();
  });

  it('ignores a temporary file left by a process that died mid-write', async () => {
    await writeRaw('{}');
    await rm(path);
    await writeFile(join(directory, 'agentchat', '.credentials.json.123.abc.tmp'), 'junk');

    await expect(store().load()).resolves.toBeNull();
  });
});

describe('round trip', () => {
  it('returns exactly what was saved', async () => {
    const subject = store();
    await subject.save(CREDENTIALS);

    await expect(subject.load()).resolves.toEqual(CREDENTIALS);
  });

  it('lets a second store observe a save made by the first', async () => {
    // Two `agentchat` processes share this file, and refresh tokens rotate. A
    // store that cached would hand back a token the other process has already
    // spent, and the server revokes the whole chain for that.
    const writer = store();
    const reader = store();

    await writer.save(CREDENTIALS);
    await expect(reader.load()).resolves.toEqual(CREDENTIALS);

    const rotated = { accessToken: 'access-2', refreshToken: 'refresh-2' };
    await writer.save(rotated);
    await expect(reader.load()).resolves.toEqual(rotated);
  });

  it('refuses to persist a half pair', async () => {
    // Writing this would produce a file that parses and then fails at the
    // first refresh, which is much harder to diagnose than failing here.
    await expect(store().save({ accessToken: 'a', refreshToken: '' })).rejects.toBeInstanceOf(
      CliError,
    );
    await expect(store().load()).resolves.toBeNull();
  });

  it('preserves fields it does not own across a refresh', async () => {
    // Plan §6.1 lists `user` and `serverUrl` in this file. This store owns the
    // two tokens; deleting the rest on every refresh would be data loss.
    await writeRaw(
      JSON.stringify({ accessToken: 'old', refreshToken: 'old-r', user: 'usr_1', serverUrl: 'x' }),
    );
    await store().save(CREDENTIALS);

    const document: unknown = JSON.parse(await readFile(path, 'utf8'));
    expect(document).toMatchObject({
      user: 'usr_1',
      serverUrl: 'x',
      accessToken: CREDENTIALS.accessToken,
      refreshToken: CREDENTIALS.refreshToken,
    });
  });
});

describe('permissions', () => {
  it.skipIf(!POSIX)('writes the file 0600 and its directory 0700', async () => {
    await store().save(CREDENTIALS);

    expect(await modeOf(path)).toBe(CREDENTIALS_FILE_MODE);
    expect(await modeOf(join(directory, 'agentchat'))).toBe(CONFIG_DIRECTORY_MODE);
  });

  it.skipIf(!POSIX)('is not at the mercy of umask', async () => {
    // `open`'s mode argument is filtered through umask, which can only remove
    // bits. A permissive umask must not widen the file, and a restrictive one
    // must not leave it unwritable for the next refresh.
    const previous = process.umask(0o000);
    try {
      await store().save(CREDENTIALS);
      expect(await modeOf(path)).toBe(CREDENTIALS_FILE_MODE);
      expect(await modeOf(join(directory, 'agentchat'))).toBe(CONFIG_DIRECTORY_MODE);
    } finally {
      process.umask(previous);
    }
  });

  it.skipIf(!POSIX)('tightens a directory that already exists too openly', async () => {
    await mkdir(join(directory, 'agentchat'), { recursive: true, mode: 0o777 });
    await chmod(join(directory, 'agentchat'), 0o777);

    await store().save(CREDENTIALS);

    expect(await modeOf(join(directory, 'agentchat'))).toBe(CONFIG_DIRECTORY_MODE);
  });

  it.skipIf(!POSIX || ROOT)('narrows a world-readable file and says so', async () => {
    await writeRaw(JSON.stringify(CREDENTIALS));
    await chmod(path, 0o644);

    await expect(store().load()).resolves.toEqual(CREDENTIALS);

    // Repaired, not merely reported: the exposure stops now.
    expect(await modeOf(path)).toBe(CREDENTIALS_FILE_MODE);
    // And reported, not merely repaired: the token may already have been read,
    // and only the user can decide to rotate it.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(path);
    expect(warnings[0]).toContain('agentchat login');
    expect(warnings.join('\n')).not.toContain(CANARY);
  });

  it.skipIf(!POSIX || ROOT)('does not warn about a file that is already 0600', async () => {
    await store().save(CREDENTIALS);
    await store().load();

    expect(warnings).toEqual([]);
  });

  it('works without a warning sink', async () => {
    const subject = createCredentialStore({ path });
    await subject.save(CREDENTIALS);

    await expect(subject.load()).resolves.toEqual(CREDENTIALS);
  });

  it('reports where it is reading and writing', () => {
    // For the messages other commands print, so no caller has to reconstruct
    // the path resolution and get it subtly different.
    expect(store().path).toBe(path);
  });

  it.skipIf(!POSIX || ROOT)('refuses a file that belongs to somebody else', async () => {
    // Real on a shared machine, and impossible to arrange in a test without
    // root, so the identity of *this* process is what moves instead. The
    // effect is the same comparison against the file's owner.
    await writeRaw(JSON.stringify(CREDENTIALS));
    vi.spyOn(process, 'getuid').mockReturnValue(0xf00d);

    const failure = await store()
      .load()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    const error = failure as CliError;
    // Not repaired: it is not ours to chmod, and reading a credential somebody
    // else placed there is the thing to not do.
    expect(error.message).toContain('another user');
    expect(error.message).not.toContain(CANARY);
    expect(warnings).toEqual([]);
  });

  it.skipIf(!POSIX)('refuses to read credentials through a symbolic link', async () => {
    // `save()` renames over this path, replacing the link rather than
    // following it, so a symlink here cannot survive the first refresh anyway.
    const real = join(directory, 'elsewhere.json');
    await writeFile(real, JSON.stringify(CREDENTIALS), { mode: 0o600 });
    await mkdir(join(directory, 'agentchat'), { recursive: true, mode: 0o700 });
    await symlink(real, path);

    const failure = await store()
      .load()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toContain('symbolic link');
  });
});

describe('atomicity', () => {
  it('replaces the file rather than rewriting it in place', async () => {
    // A rename produces a new inode. That is the observable signature of
    // "a reader sees the old file or the new one, never a truncated one".
    const subject = store();
    await subject.save(CREDENTIALS);
    const before = (await stat(path)).ino;

    await subject.save({ accessToken: 'access-2', refreshToken: 'refresh-2' });

    expect((await stat(path)).ino).not.toBe(before);
  });

  it('leaves no temporary files behind', async () => {
    const subject = store();
    await subject.save(CREDENTIALS);
    await subject.save({ accessToken: 'access-2', refreshToken: 'refresh-2' });

    expect(await readdir(join(directory, 'agentchat'))).toEqual(['credentials.json']);
  });

  it.skipIf(!POSIX || ROOT)(
    'leaves the previous credentials intact when a write fails',
    async () => {
      const subject = store();
      await subject.save(CREDENTIALS);
      await chmod(join(directory, 'agentchat'), 0o500);

      await expect(subject.save({ accessToken: 'a2', refreshToken: 'r2' })).rejects.toBeInstanceOf(
        CliError,
      );

      // Still the old pair, complete and loadable: nothing was truncated before
      // the replacement was ready.
      await chmod(join(directory, 'agentchat'), 0o700);
      await expect(subject.load()).resolves.toEqual(CREDENTIALS);
      expect(await readdir(join(directory, 'agentchat'))).toEqual(['credentials.json']);
    },
  );

  it('never exposes a pair whose two tokens come from different saves', async () => {
    // The failure this guards: a store that wrote the access token and then
    // the refresh token would, under a concurrent read, hand out a mismatched
    // pair — and the server revokes the chain for a refresh token that does
    // not belong to the session presenting it.
    const subject = store();
    await subject.save({ accessToken: 'access-0', refreshToken: 'refresh-0' });

    const work: Promise<void>[] = [];
    for (let generation = 1; generation <= 40; generation += 1) {
      work.push(
        subject.save({
          accessToken: `access-${generation}`,
          refreshToken: `refresh-${generation}`,
        }),
      );
      work.push(
        (async () => {
          const loaded = await subject.load();
          expect(loaded).not.toBeNull();
          const access = loaded?.accessToken.replace('access-', '');
          const refresh = loaded?.refreshToken.replace('refresh-', '');
          expect(access).toBe(refresh);
        })(),
      );
    }

    await Promise.all(work);
    expect(await readdir(join(directory, 'agentchat'))).toEqual(['credentials.json']);
  });
});

describe('corruption', () => {
  const damaged: ReadonlyArray<readonly [string, string]> = [
    ['truncated mid-write', `{"accessToken": "access-${CANARY}", "refreshTok`],
    ['empty', ''],
    ['not JSON at all', 'this is not json'],
    ['a JSON array', '[]'],
    ['a JSON string', '"hello"'],
    ['missing the refresh token', `{"accessToken": "access-${CANARY}"}`],
    ['missing the access token', `{"refreshToken": "refresh-${CANARY}"}`],
    ['an empty access token', `{"accessToken": "", "refreshToken": "refresh-${CANARY}"}`],
    ['a non-string token', `{"accessToken": 42, "refreshToken": "refresh-${CANARY}"}`],
  ];

  for (const [description, contents] of damaged) {
    it(`tells the user to log in again when the file is ${description}`, async () => {
      await writeRaw(contents);

      const failure = await store()
        .load()
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(CliError);
      const error = failure as CliError;
      expect(error.code).toBe(ErrorCode.AUTH_REQUIRED);
      expect(error.hint).toContain('agentchat login');
      // Exit 3: a harness reading this knows to re-run login, not to retry.
      expect(describeFailure(error).exit).toBe(ExitCode.AUTH_REQUIRED);
    });
  }

  it('refuses a file far too large to be a credentials file', async () => {
    // A mistyped path pointing at something enormous must not be read into
    // memory to discover that it is not two tokens.
    await writeRaw(`{"accessToken": "${'x'.repeat(70_000)}", "refreshToken": "y"}`);

    const failure = await store()
      .load()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).code).toBe(ErrorCode.AUTH_REQUIRED);
  });

  it('never returns a partial credential', async () => {
    await writeRaw(`{"accessToken": "access-${CANARY}"}`);

    // Half a pair would reach `/auth/refresh` as `undefined` and end in a
    // logout whose cause is invisible.
    await expect(store().load()).rejects.toBeInstanceOf(CliError);
  });

  it('does not put the file contents in the error, the cause, or the rendering', async () => {
    // `JSON.parse` quotes a fragment of its input in the message it throws,
    // and `--verbose` prints the cause chain. That fragment is a token, so the
    // parse error is discarded rather than attached.
    await writeRaw(`{"accessToken": "access-${CANARY}", "refreshToken": "refresh-${CANARY}`);

    const failure = (await store()
      .load()
      .catch((error: unknown) => error)) as CliError;
    const rendered = [
      failure.message,
      failure.hint ?? '',
      ...causeChain(failure),
      JSON.stringify(describeFailure(failure)),
    ].join('\n');

    expect(rendered).not.toContain(CANARY);
    expect(failure.cause).toBeUndefined();
  });

  it('overwrites a corrupt file instead of failing on it', async () => {
    // Repairing the file is the whole point of the write; refusing to write
    // because the thing being replaced is broken would be a permanent logout.
    await writeRaw('}{ not json');

    const subject = store();
    await subject.save(CREDENTIALS);

    await expect(subject.load()).resolves.toEqual(CREDENTIALS);
  });

  it.skipIf(!POSIX)('reports a file that is not a regular file', async () => {
    await mkdir(join(directory, 'agentchat'), { recursive: true, mode: 0o700 });
    await mkdir(path, { mode: 0o700 });

    const failure = await store()
      .load()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).toContain(path);
  });
});

describe('a machine that will not cooperate', () => {
  it.skipIf(!POSIX || ROOT)('explains an unreadable file without a stack trace', async () => {
    await writeRaw(JSON.stringify(CREDENTIALS));
    await chmod(path, 0o000);

    const failure = await store()
      .load()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    const error = failure as CliError;
    // Not AUTH_REQUIRED: logging in again would fail on the same file, so
    // pointing a harness at `agentchat login` would loop.
    expect(error.code).toBe(ErrorCode.INTERNAL);
    expect(error.message).toContain('permission denied');
    expect(error.message).not.toContain(CANARY);
    expect(describeFailure(error).exit).toBe(ExitCode.FAILURE);
  });

  it.skipIf(!POSIX || ROOT)('explains an unwritable directory', async () => {
    await mkdir(join(directory, 'agentchat'), { recursive: true, mode: 0o700 });
    await chmod(join(directory, 'agentchat'), 0o500);

    const failure = await store()
      .save(CREDENTIALS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    const error = failure as CliError;
    expect(error.code).toBe(ErrorCode.INTERNAL);
    expect(error.message).toContain('permission denied');
    expect(error.message).not.toContain(CANARY);
    expect(error.hint).toBeTruthy();
  });

  it.skipIf(!POSIX || ROOT)('explains a directory it cannot create', async () => {
    await chmod(directory, 0o500);

    const failure = await store()
      .save(CREDENTIALS)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    const error = failure as CliError;
    expect(error.code).toBe(ErrorCode.INTERNAL);
    expect(error.message).toContain('configuration directory');
    expect(error.message).toContain('permission denied');
    expect(error.message).not.toContain(CANARY);
  });

  it.skipIf(!POSIX || ROOT)('explains a file it cannot remove', async () => {
    await writeRaw(JSON.stringify(CREDENTIALS));
    await chmod(join(directory, 'agentchat'), 0o500);

    const failure = await store()
      .clear()
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CliError);
    expect((failure as CliError).message).not.toContain(CANARY);
  });

  it('keeps every token out of the messages it produces', async () => {
    // One sweep over the whole surface: whatever went wrong, and whatever was
    // warned about, none of it may quote a credential.
    await writeRaw(`{"accessToken": "access-${CANARY}"`);
    const failure = await store()
      .load()
      .catch((error: unknown) => String(error));

    const subject = store();
    await subject.save(CREDENTIALS);
    if (POSIX && !ROOT) {
      await chmod(path, 0o666);
      await subject.load();
    }

    expect([String(failure), ...warnings].join('\n')).not.toContain(CANARY);
  });
});
