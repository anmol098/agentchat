/**
 * The tokens on disk: one file, mode 0600, replaced atomically.
 *
 * `@agentchat/client` declares {@link CredentialStore} and deliberately owns no
 * filesystem code (T-202). This module is the CLI's implementation of it, and
 * it is the only place in this repository that a refresh token is written down.
 * Everything here follows from that: the mode bits, the rename, the ownership
 * check, and the rule that no error this module raises ever quotes the file's
 * contents.
 *
 * ## Where the file lives
 *
 * ```text
 * ~/.config/agentchat/credentials.json     mode 0600, in a directory with 0700
 * ```
 *
 * That is plan §6.1. `XDG_CONFIG_HOME` is honoured when it holds an absolute
 * path, because `~/.config` *is* the XDG default and a user who has moved it
 * has moved it for everything. No `AGENTCHAT_*` variable overrides the location:
 * tests pass an explicit path to the constructor instead, so this module adds
 * nothing to the CLI's public environment surface.
 *
 * ## Why it is re-read on every request
 *
 * The client loads before every authenticated call rather than caching, because
 * refresh tokens rotate and two `agentchat` processes share this one file. A
 * cached access token would send the process to `/auth/refresh` with a refresh
 * token the other process has already spent, and the server revokes the whole
 * chain when a spent token is presented — logging the user out of both. So
 * {@link FileCredentialStore} holds no state at all between calls. `load()` is a
 * `stat` and a small read; that is the price of correctness here and it is a
 * cheap one.
 *
 * ## Atomicity
 *
 * `save()` writes a temporary file **in the same directory**, `fsync`s it, and
 * `rename`s it over the target. `rename(2)` is atomic only within a filesystem,
 * so a temporary file in `/tmp` would degrade to a copy — a window in which the
 * destination is truncated and the tokens exist nowhere. Same directory, always.
 *
 * The consequence a reader can observe is that the destination is *replaced*,
 * never modified: a concurrent `load()` sees either the whole previous pair or
 * the whole new one. Both tokens therefore land together, which is what
 * {@link CredentialStore.save} means by writing them atomically — an access
 * token persisted without its refresh token has stranded the account.
 *
 * ## Permissions
 *
 * The file is created 0600 and the directory 0700, and both are `chmod`ed
 * explicitly after creation because `umask` subtracts from the mode passed to
 * `open` and `mkdir` but never adds to it.
 *
 * `load()` **repairs and reports** a file that others can read: it narrows the
 * mode to 0600 and warns. Refusing to load would not un-leak a token that has
 * already been world-readable, and it would turn a stray `umask` or a restored
 * backup into a hard failure; repairing silently would leave the user unaware
 * that a credential may have been copied. Narrowing stops the exposure now, and
 * the warning tells them to rotate. A file owned by *another user* is a
 * different case and is refused outright: it is not ours to repair, `chmod`
 * would fail anyway, and reading a credential somebody else planted is exactly
 * the thing to not do.
 *
 * A symbolic link at the credentials path is likewise refused. `save()` renames
 * over the path, which would replace the link rather than follow it, so a
 * symlink here cannot survive the first token refresh in any case; failing
 * loudly beats appearing to work until then.
 *
 * **Windows is out of scope for all of the above**, and says so rather than
 * pretending: `chmod` there toggles a read-only flag and nothing else, and
 * `stat().uid` is 0 for everyone. On `win32` this module skips the mode and
 * ownership work entirely and the file's protection is whatever the user's
 * profile directory grants. The atomic replace still holds — Node's `rename`
 * uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`. v0.1 targets POSIX; a
 * Windows story needs DPAPI or the credential manager, which is the same
 * conversation as the keychain below.
 *
 * ## The keychain seam
 *
 * OS keychain storage is a v0.2 candidate (plan §8). Everything outside this
 * file names the {@link CredentialStore} interface and obtains its instance from
 * {@link createCredentialStore}, so swapping the backend is a change to this
 * module and to nothing else.
 *
 * @module
 */

import { randomBytes } from 'node:crypto';
import { constants as FS } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { CredentialStore, Credentials } from '@agentchat/client';
import { ErrorCode } from '@agentchat/protocol';

import { CliError } from './errors.js';

/** Mode of the credentials file: readable and writable by its owner only. */
export const CREDENTIALS_FILE_MODE = 0o600;

/** Mode of the directory holding it: no access at all for anybody else. */
export const CONFIG_DIRECTORY_MODE = 0o700;

/** Name of the file within the configuration directory. */
export const CREDENTIALS_FILE_NAME = 'credentials.json';

/**
 * Format version written into the file.
 *
 * Recorded so a future change of shape is detectable rather than guessed at. It
 * is deliberately *not* validated on read: the two tokens are the contract, and
 * refusing a file because its version is unfamiliar would log a user out for a
 * field they cannot see.
 */
export const CREDENTIALS_FORMAT_VERSION = 1;

/**
 * Whether this platform has file modes worth enforcing.
 *
 * `false` on Windows. See the module note: the alternative is code that calls
 * `chmod`, has no effect, and reports success.
 */
const PERMISSIONS_ENFORCED = process.platform !== 'win32';

/**
 * Largest file this module will read.
 *
 * Two tokens and a little JSON around them. A file bigger than this is not a
 * credentials file, and reading it into memory to discover that is how a
 * mistyped path becomes an out-of-memory crash.
 */
const MAX_FILE_BYTES = 64 * 1024;

/** Told to the user whenever the stored pair cannot be used. */
const LOG_IN_AGAIN = 'Run `agentchat login` to sign in again.';

/**
 * Reports something the user should know but that did not stop the command.
 *
 * A plain callback rather than the CLI's `Logger`, so this module depends on
 * nothing in `./output/` and a test can assert on what was said. Wire it to
 * `context.log.warn`.
 *
 * @param message - One line, no trailing newline, and — like every string this
 *   module produces — no token in it.
 */
export type WarnCallback = (message: string) => void;

/** Construction options for {@link FileCredentialStore}. */
export interface FileCredentialStoreOptions {
  /**
   * Absolute path to the credentials file. Defaults to
   * {@link credentialsPath}. Tests pass a temporary directory; production does
   * not pass anything.
   */
  readonly path?: string;

  /**
   * Where to report a repaired permission. Defaults to discarding it, so a
   * caller that has nowhere to write is not forced to invent one.
   */
  readonly warn?: WarnCallback;
}

/**
 * The directory AgentChat keeps user-level configuration in.
 *
 * @param env - Environment to read `XDG_CONFIG_HOME` from. Defaults to
 *   `process.env`.
 * @param home - The user's home directory. Defaults to `os.homedir()`.
 * @returns An absolute path, which may not exist yet.
 */
export function configDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  const xdg = env['XDG_CONFIG_HOME'];
  // A relative XDG_CONFIG_HOME is meaningless — it would resolve against
  // whatever directory the user happened to run the command in — so it is
  // ignored rather than honoured into a surprising location.
  const base = xdg !== undefined && xdg !== '' && isAbsolute(xdg) ? xdg : join(home, '.config');
  return join(base, 'agentchat');
}

/**
 * The documented path of the credentials file (plan §6.1).
 *
 * @param env - Environment to read `XDG_CONFIG_HOME` from.
 * @param home - The user's home directory.
 * @returns An absolute path, which may not exist yet.
 */
export function credentialsPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homedir(),
): string {
  return join(configDirectory(env, home), CREDENTIALS_FILE_NAME);
}

/**
 * The {@link CredentialStore} the `agentchat` CLI runs on.
 *
 * @param options - Path and warning sink; both optional.
 * @returns A store, named by its interface so the call site is unaffected when
 *   v0.2 puts a keychain behind it.
 */
export function createCredentialStore(options: FileCredentialStoreOptions = {}): CredentialStore {
  return new FileCredentialStore(options);
}

/**
 * A {@link CredentialStore} backed by one 0600 file.
 *
 * Stateless between calls: see the module note on why nothing is cached.
 */
export class FileCredentialStore implements CredentialStore {
  readonly #path: string;
  readonly #warn: WarnCallback;

  /**
   * @param options - Path and warning sink; both optional.
   */
  public constructor(options: FileCredentialStoreOptions = {}) {
    this.#path = options.path ?? credentialsPath();
    this.#warn = options.warn ?? (() => {});
  }

  /** Where this store reads and writes. Useful in messages and in tests. */
  public get path(): string {
    return this.#path;
  }

  /**
   * Reads the current credentials, repairing an over-permissive file first.
   *
   * @returns The stored pair, or `null` when nothing is stored — which is the
   *   ordinary logged-out case and not a failure.
   * @throws {CliError} `AUTH_REQUIRED` when the file exists but cannot be
   *   understood, so the remedy is a fresh login. `INTERNAL` when the file
   *   exists and the machine will not let this process read it — a broken
   *   setup, which logging in again would not fix.
   */
  public async load(): Promise<Credentials | null> {
    const handle = await this.#openForRead();
    if (handle === null) {
      return null;
    }

    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new CliError(
          ErrorCode.INTERNAL,
          `Expected a file at ${this.#path}, but it is not one.`,
          { hint: 'Remove whatever is at that path, then run `agentchat login`.' },
        );
      }
      if (info.size > MAX_FILE_BYTES) {
        throw this.#corrupt();
      }

      await this.#auditPermissions(handle, info.mode, info.uid);

      const text = await handle.readFile('utf8');
      return this.#parse(text);
    } finally {
      await handle.close();
    }
  }

  /**
   * Replaces the stored pair, atomically and with both tokens together.
   *
   * @param credentials - The newly issued pair.
   * @throws {CliError} `INTERNAL` if the directory or the file cannot be
   *   written. The previous contents are left intact in that case; nothing is
   *   truncated before the replacement is complete on disk.
   */
  public async save(credentials: Credentials): Promise<void> {
    assertUsable(credentials);

    const directory = dirname(this.#path);
    await this.#ensureDirectory(directory);

    // Fields a later task may have added to this file — plan §6.1 lists `user`
    // and `serverUrl` — survive a token refresh. This store owns the two
    // tokens and preserves the rest rather than deleting data it does not
    // understand. A corrupt or absent file simply contributes nothing.
    const preserved = await this.#preservedFields();
    const document = {
      ...preserved,
      version: CREDENTIALS_FORMAT_VERSION,
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
    };

    await this.#writeAtomically(directory, `${JSON.stringify(document, null, 2)}\n`);
  }

  /**
   * Forgets the stored pair.
   *
   * @throws {CliError} `INTERNAL` if the file exists and cannot be removed.
   *   Clearing an already-empty store is a success, per the interface.
   */
  public async clear(): Promise<void> {
    try {
      await unlink(this.#path);
    } catch (cause) {
      if (isMissing(cause)) {
        return;
      }
      throw new CliError(
        ErrorCode.INTERNAL,
        `Could not remove the credentials file at ${this.#path}: ${reasonOf(cause)}.`,
        { hint: 'Check the file’s ownership and permissions, then try again.', cause },
      );
    }
  }

  /**
   * Opens the file for reading, refusing a symlink.
   *
   * @returns An open handle, or `null` when nothing is stored there.
   * @throws {CliError} `INTERNAL` for a symlink or an unreadable file.
   */
  async #openForRead(): Promise<FileHandle | null> {
    // O_NOFOLLOW: the final component must be a real file. See the module note
    // — `save()` renames over this path, so a symlink here would not survive a
    // refresh anyway.
    const flags = PERMISSIONS_ENFORCED ? FS.O_RDONLY | FS.O_NOFOLLOW : FS.O_RDONLY;
    try {
      return await open(this.#path, flags);
    } catch (cause) {
      if (isMissing(cause)) {
        return null;
      }
      if (errnoOf(cause) === 'ELOOP') {
        throw new CliError(
          ErrorCode.INTERNAL,
          `The credentials path ${this.#path} is a symbolic link; refusing to read credentials through it.`,
          {
            hint: 'Replace the link with a regular file by running `agentchat login`.',
            cause,
          },
        );
      }
      throw new CliError(
        ErrorCode.INTERNAL,
        `Could not read the credentials file at ${this.#path}: ${reasonOf(cause)}.`,
        {
          hint: 'Check that you own the file and that it is readable, then try again.',
          cause,
        },
      );
    }
  }

  /**
   * Refuses a foreign file and narrows an over-permissive one.
   *
   * Operates on the open descriptor rather than the path, so nothing can be
   * swapped underneath between the check and the repair.
   *
   * @param handle - The open credentials file.
   * @param mode - Its mode, from `fstat`.
   * @param uid - Its owner, from `fstat`.
   * @throws {CliError} `INTERNAL` when the file belongs to another user.
   */
  async #auditPermissions(handle: FileHandle, mode: number, uid: number): Promise<void> {
    if (!PERMISSIONS_ENFORCED || typeof process.getuid !== 'function') {
      return;
    }

    const me = process.getuid();
    // Root reads everything and owns nothing in particular; the check would
    // reject a file it is perfectly entitled to read.
    if (me !== 0 && uid !== me) {
      throw new CliError(
        ErrorCode.INTERNAL,
        `The credentials file at ${this.#path} belongs to another user (uid ${uid}).`,
        {
          hint: 'Have its owner remove it, or point HOME at your own account, then run `agentchat login`.',
        },
      );
    }

    if ((mode & 0o077) === 0) {
      return;
    }

    try {
      await handle.chmod(CREDENTIALS_FILE_MODE);
      this.#warn(
        `${this.#path} was readable by other users; its permissions have been narrowed to 0600. ` +
          'If this machine is shared, run `agentchat logout` and `agentchat login` to replace the tokens.',
      );
    } catch (cause) {
      this.#warn(
        `${this.#path} is readable by other users and its permissions could not be corrected ` +
          `(${reasonOf(cause)}). Run \`chmod 600\` on it, then \`agentchat logout\` and \`agentchat login\`.`,
      );
    }
  }

  /**
   * Turns the file's bytes into credentials.
   *
   * @param text - The whole file.
   * @returns The stored pair.
   * @throws {CliError} `AUTH_REQUIRED` if it is not a credentials document.
   */
  #parse(text: string): Credentials {
    const document = parseObject(text);
    if (document === null) {
      throw this.#corrupt();
    }

    const accessToken = document['accessToken'];
    const refreshToken = document['refreshToken'];
    // Both or neither. Returning a pair with one token missing would send the
    // client to `/auth/refresh` with `undefined` and end in a logout whose
    // cause is invisible.
    if (!isNonEmptyString(accessToken) || !isNonEmptyString(refreshToken)) {
      throw this.#corrupt();
    }

    return { accessToken, refreshToken };
  }

  /**
   * The failure for a file that exists but is not usable.
   *
   * Carries `AUTH_REQUIRED`, so the process exits 3 and a harness knows to run
   * `agentchat login` rather than to retry.
   *
   * Deliberately **without** a `cause`: `JSON.parse` puts a fragment of its
   * input into the message it throws, `--verbose` prints the cause chain, and
   * that fragment is a token.
   *
   * @returns The error to throw.
   */
  #corrupt(): CliError {
    return new CliError(
      ErrorCode.AUTH_REQUIRED,
      `The saved credentials at ${this.#path} are unreadable or damaged.`,
      { hint: LOG_IN_AGAIN },
    );
  }

  /**
   * Everything in the current file except the fields this store owns.
   *
   * @returns The fields to carry forward; empty when there is no readable file.
   */
  async #preservedFields(): Promise<Record<string, unknown>> {
    let text: string;
    try {
      const handle = await this.#openForRead();
      if (handle === null) {
        return {};
      }
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) {
          return {};
        }
        text = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
    } catch {
      // A save must never fail because the file it is replacing is broken —
      // repairing that file is the whole point of the write about to happen.
      return {};
    }

    const document = parseObject(text);
    if (document === null) {
      return {};
    }

    const { accessToken: _access, refreshToken: _refresh, version: _version, ...rest } = document;
    return rest;
  }

  /**
   * Creates the configuration directory with 0700 if it is not already there.
   *
   * @param directory - The directory to ensure.
   * @throws {CliError} `INTERNAL` if it cannot be created or is not ours.
   */
  async #ensureDirectory(directory: string): Promise<void> {
    try {
      // The parent chain (`~/.config`) is created with the default mode: it
      // holds other applications' configuration and is not this CLI's to
      // restrict. Only the leaf, which holds the tokens, is forced to 0700.
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory, { mode: CONFIG_DIRECTORY_MODE });
    } catch (cause) {
      if (errnoOf(cause) !== 'EEXIST') {
        throw new CliError(
          ErrorCode.INTERNAL,
          `Could not create the configuration directory ${directory}: ${reasonOf(cause)}.`,
          { hint: 'Check that your home directory is writable, then try again.', cause },
        );
      }
    }

    if (!PERMISSIONS_ENFORCED) {
      return;
    }

    // `mkdir`'s mode is filtered through `umask`, and an existing directory
    // kept whatever mode it was made with, so the mode is asserted rather than
    // assumed. Unlike the file, this is not worth a warning: a 0755 directory
    // holding a 0600 file has leaked nothing.
    try {
      const info = await stat(directory);
      if ((info.mode & 0o077) !== 0) {
        const handle = await open(directory, FS.O_RDONLY);
        try {
          await handle.chmod(CONFIG_DIRECTORY_MODE);
        } finally {
          await handle.close();
        }
      }
    } catch {
      // Best effort. If the directory cannot be tightened the write below will
      // still refuse to leave a world-readable *file*, which is the credential.
    }
  }

  /**
   * Writes the payload so that a reader sees all of it or none of it.
   *
   * @param directory - The directory holding the credentials file. The
   *   temporary file goes here too: `rename` is atomic only within one
   *   filesystem, and across two it silently becomes copy-then-unlink.
   * @param payload - The complete file contents.
   * @throws {CliError} `INTERNAL` if any step fails. The destination is
   *   untouched unless the final `rename` succeeded.
   */
  async #writeAtomically(directory: string, payload: string): Promise<void> {
    const temporary = join(
      directory,
      `.${basename(this.#path)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`,
    );

    try {
      // O_EXCL: never write through an existing file, which on a shared
      // machine could be a link somebody else planted.
      const handle = await open(
        temporary,
        FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL,
        CREDENTIALS_FILE_MODE,
      );
      try {
        // `umask` can only clear bits from the mode above, never set them, so
        // the mode is applied again on the descriptor. A umask of 0177 would
        // otherwise leave the file 0400 and unwritable next time.
        if (PERMISSIONS_ENFORCED) {
          await handle.chmod(CREDENTIALS_FILE_MODE);
        }
        await handle.writeFile(payload, 'utf8');
        // Before the rename, not after: a rename that reaches the disk ahead
        // of the bytes it points at is a zero-length credentials file after a
        // power loss, which is the exact failure the rename is here to avoid.
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (cause) {
      await discard(temporary);
      throw new CliError(
        ErrorCode.INTERNAL,
        `Could not write credentials to ${directory}: ${reasonOf(cause)}.`,
        { hint: 'Check that the directory is writable and that the disk is not full.', cause },
      );
    }

    try {
      await rename(temporary, this.#path);
    } catch (cause) {
      await discard(temporary);
      throw new CliError(
        ErrorCode.INTERNAL,
        `Could not replace the credentials file at ${this.#path}: ${reasonOf(cause)}.`,
        { hint: 'Check that you own the file and that its directory is writable.', cause },
      );
    }

    await syncDirectory(directory);
  }
}

/**
 * Rejects a pair that would strand the account if it were written.
 *
 * @param credentials - The pair about to be saved.
 * @throws {CliError} `INTERNAL` if either token is missing or empty. This is a
 *   bug in a caller rather than something a user can fix, but writing it would
 *   produce a file that only looks valid.
 */
function assertUsable(credentials: Credentials): void {
  if (!isNonEmptyString(credentials.accessToken) || !isNonEmptyString(credentials.refreshToken)) {
    throw new CliError(
      ErrorCode.INTERNAL,
      'Refusing to save credentials with a missing access or refresh token.',
      { hint: 'This is a bug in `agentchat`. Re-run with --verbose for the details.' },
    );
  }
}

/**
 * Parses text expected to be a JSON object.
 *
 * @param text - The file contents.
 * @returns The object, or `null` if the text is not one. The parse error itself
 *   is discarded rather than returned or attached anywhere: it quotes its
 *   input, and the input is a credential.
 */
function parseObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/**
 * @param value - Anything.
 * @returns `true` for a string with something in it.
 */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The `errno` code of a thrown value.
 *
 * @param error - Whatever the filesystem threw.
 * @returns The code (`'ENOENT'`, `'EACCES'`, …), or `null` if it has none.
 */
function errnoOf(error: unknown): string | null {
  if (error instanceof Error && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * @param error - Whatever the filesystem threw.
 * @returns `true` when it means "there is nothing at that path".
 */
function isMissing(error: unknown): boolean {
  const code = errnoOf(error);
  // ENOTDIR: a component of the path is a file. Nothing is stored there either
  // way, and the write path reports the real problem with an actionable message.
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * A short phrase describing a filesystem failure, for the end of a sentence.
 *
 * Derived from the `errno` code rather than from the thrown message, which
 * embeds paths and is not written for users.
 *
 * @param error - Whatever the filesystem threw.
 * @returns The phrase.
 */
function reasonOf(error: unknown): string {
  switch (errnoOf(error)) {
    case 'EACCES':
    case 'EPERM':
      return 'permission denied';
    case 'EROFS':
      return 'the filesystem is read-only';
    case 'ENOSPC':
      return 'the disk is full';
    case 'EDQUOT':
      return 'the disk quota is exhausted';
    case 'ENOENT':
      return 'the path does not exist';
    case 'ENOTDIR':
      return 'a component of the path is not a directory';
    case 'EISDIR':
      return 'the path is a directory';
    case 'ELOOP':
      return 'the path is a symbolic link';
    case 'EMFILE':
    case 'ENFILE':
      return 'too many open files';
    default:
      return 'the operation failed';
  }
}

/**
 * Removes a temporary file, ignoring every failure.
 *
 * @param path - The file to remove.
 */
async function discard(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // The write already failed; a leftover temporary file is the lesser
    // problem and reporting it would replace the real error.
  }
}

/**
 * Flushes the directory entry so the rename itself survives a power loss.
 *
 * Best effort: Windows cannot open a directory as a file, and some filesystems
 * reject `fsync` on one. The rename is atomic regardless — this only affects
 * whether it is still there after the machine loses power a moment later.
 *
 * @param directory - The directory whose entry changed.
 */
async function syncDirectory(directory: string): Promise<void> {
  if (!PERMISSIONS_ENFORCED) {
    return;
  }
  try {
    const handle = await open(directory, FS.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Durability is improved where it can be and skipped where it cannot.
  }
}
