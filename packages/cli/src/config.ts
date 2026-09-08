/**
 * The two configuration files, and the rule that keeps them apart.
 *
 * ```text
 * <repo>/.agentchat/config.json        committed   { projectId, projectSlug? }
 * ~/.config/agentchat/config.json      personal    { serverUrl?, defaultAgentByProject }
 * ```
 *
 * ## Why the split is not negotiable
 *
 * The repository file is committed (D12) so that every clone of a repository
 * resolves the same project without anybody being told to run anything (PRD
 * §14). That is the whole reason it exists, and it is also the reason it may
 * hold nothing else: it is shared with everyone who can read the repository,
 * including — for a public one — everyone.
 *
 * Which agent a person speaks as is the opposite kind of fact. Two developers
 * cloning the same repository must not inherit each other's agent, so the
 * default agent lives in *user* configuration, keyed by project id (plan §6.1,
 * PRD §15). A repository config that tried to carry it would be wrong on the
 * first `git clone`.
 *
 * ## The repository file is verified, not trusted
 *
 * `.agentchat/config.json` is a file that arrives over the network, in a
 * repository somebody else may have written, and this process reads it before
 * it has authenticated anything. So {@link parseRepositoryConfig} rejects any
 * document carrying something credential-shaped — a key called `token`, a value
 * shaped like a JWT — rather than reading past it. Two things go wrong when a
 * secret ends up in this file, and refusing to read it addresses both: the
 * secret has been committed and must be rotated, which a loud failure is the
 * only way anyone finds out; and a repository could otherwise hand a cloner's
 * CLI a server URL and a token of the author's choosing.
 *
 * Unknown *ordinary* keys are ignored rather than rejected, because a newer
 * `agentchat` may write a field this build has never heard of and an older CLI
 * refusing to open the file would make every such addition a breaking change.
 * Credential-shaped keys are the exception, and they are an exception on
 * purpose.
 *
 * ## Failures name the file
 *
 * Every error raised here quotes the absolute path of the file it is complaining
 * about and says what is wrong with it. "Invalid configuration" is a message
 * that leaves the reader running `find` for a file they did not know existed.
 *
 * @module
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

// `AgentId` and `ProjectId` are each a type and a value in `@agentchat/protocol`
// — the branded string and the operations on it — so one import carries both.
import { AgentId, ErrorCode, PROJECT_SLUG_PATTERN, ProjectId } from '@agentchat/protocol';

import { CliError } from './errors.js';

/** The per-repository configuration directory: `.agentchat`. */
export const REPOSITORY_CONFIG_DIR = '.agentchat';

/** The file inside it. Also the name of the user configuration file. */
export const CONFIG_FILENAME = 'config.json';

/** `.agentchat/config.json`, for messages that name it without a path. */
export const REPOSITORY_CONFIG_RELATIVE = `${REPOSITORY_CONFIG_DIR}/${CONFIG_FILENAME}`;

/** The directory under `$XDG_CONFIG_HOME` (or `~/.config`) that holds user files. */
export const USER_CONFIG_DIR = 'agentchat';

/**
 * How far up the directory tree the search for a repository configuration
 * goes before giving up.
 *
 * The walk terminates on its own — see {@link findRepositoryConfig} — so this
 * is not what makes it safe. It is a second bound, cheap enough to be worth
 * having, for a filesystem that manages to present a parent chain that never
 * reaches a fixed point.
 */
const MAX_WALK_DEPTH = 256;

/** How deep {@link findCredential} descends into a repository configuration. */
const MAX_SCAN_DEPTH = 8;

/**
 * The contents of `<repo>/.agentchat/config.json`.
 *
 * Two fields, and by design there will never be a third that is not also a
 * project identity: see the module note.
 */
export interface RepositoryConfig {
  /** The project this working tree belongs to. The identity that matters. */
  readonly projectId: ProjectId;

  /**
   * The project's slug at the time the file was written, or `null`.
   *
   * Advisory only. It exists so a human reading the diff can see which project
   * `prj_018f…` is, and so `agentchat status` can name the project without a
   * round trip. A project can be renamed, so nothing resolves by it.
   */
  readonly projectSlug: string | null;
}

/** A repository configuration and where it was found. */
export interface DiscoveredRepositoryConfig {
  /** What the file contained. */
  readonly config: RepositoryConfig;

  /** The absolute path of the file. */
  readonly path: string;

  /**
   * The absolute path of the directory holding `.agentchat/`.
   *
   * The root of the working tree as far as AgentChat is concerned, which is not
   * necessarily the root of the git repository.
   */
  readonly directory: string;
}

/**
 * The contents of `~/.config/agentchat/config.json`.
 *
 * Personal, never committed, and never containing a token: credentials are a
 * separate file with separate permissions (`./credentials.ts`, plan §6.1).
 */
export interface UserConfig {
  /** The server this user talks to, or `null` for the built-in default. */
  readonly serverUrl: string | null;

  /**
   * The default agent for each project, keyed by project id.
   *
   * Written by `agentchat agent use`. Keyed by id rather than by slug because a
   * project can be renamed and the person's choice should survive it.
   */
  readonly defaultAgentByProject: Readonly<Record<string, AgentId>>;
}

/** The configuration of a user who has never run `agentchat agent use`. */
export const EMPTY_USER_CONFIG: UserConfig = Object.freeze({
  serverUrl: null,
  defaultAgentByProject: Object.freeze({}),
});

/**
 * The path of the repository configuration inside a directory.
 *
 * @param directory - The directory that would hold `.agentchat/`.
 * @returns The absolute path of `<directory>/.agentchat/config.json`.
 */
export function repositoryConfigPath(directory: string): string {
  return join(resolve(directory), REPOSITORY_CONFIG_DIR, CONFIG_FILENAME);
}

/**
 * Finds the nearest repository configuration, walking up from a directory.
 *
 * ## Termination
 *
 * The walk is *lexical*: each step is `path.dirname` of the last, which strictly
 * shortens the string until it reaches the filesystem root and then returns the
 * root unchanged. That is the stopping condition, and it holds no matter what
 * the filesystem does, because no symbolic link is ever followed to compute the
 * next candidate. A path inside a symlink loop, or a path that is not inside any
 * repository, ends the walk at the root like any other. (`realpath` would be the
 * way to make this hang, which is why it is not used.)
 *
 * @param startDirectory - Where to start, usually the working directory.
 * @returns The nearest configuration, or `null` if there is none above the
 *   starting point.
 * @throws {CliError} `NO_PROJECT` if a configuration is found but cannot be
 *   read, is not valid JSON, is missing its project id, or carries something
 *   credential-shaped. The nearest file is the one the user meant; walking past
 *   a broken one and silently using a grandparent's project would be worse than
 *   failing.
 */
export async function findRepositoryConfig(
  startDirectory: string,
): Promise<DiscoveredRepositoryConfig | null> {
  let directory = resolve(startDirectory);

  for (let depth = 0; depth < MAX_WALK_DEPTH; depth += 1) {
    const path = join(directory, REPOSITORY_CONFIG_DIR, CONFIG_FILENAME);
    const text = await readIfPresent(path);
    if (text !== null) {
      return { config: parseRepositoryConfig(text, path), path, directory };
    }

    const parent = dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }

  return null;
}

/**
 * Reads a file, treating "it is not there" as an answer rather than a failure.
 *
 * `ENOENT` and `ENOTDIR` mean the candidate simply does not exist — the second
 * happens when a *file* called `.agentchat` sits where the directory would be —
 * and the walk continues. Anything else is real: a configuration this process
 * cannot read is not the same as one that is absent, and pretending otherwise
 * produces "no project configured" for a file the user is looking straight at.
 *
 * @param path - The candidate path.
 * @returns The file's text, or `null` if it does not exist.
 * @throws {CliError} `NO_PROJECT` for any other read failure, naming the path
 *   and the operating system's reason.
 */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (cause) {
    const code = errnoOf(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw new CliError(
      ErrorCode.NO_PROJECT,
      `\`${path}\` could not be read (${code ?? 'unknown error'}).`,
      {
        cause,
        hint: `Check the file's permissions, or delete it and run \`agentchat project init <slug>\` to write it again.`,
      },
    );
  }
}

/**
 * The `errno` code on a thrown filesystem error, if it has one.
 *
 * @param error - Any thrown value.
 * @returns The code, e.g. `ENOENT`, or `null`.
 */
function errnoOf(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : null;
  }
  return null;
}

/**
 * Parses and verifies a repository configuration.
 *
 * The order is deliberate: parse, check it is an object, scan for credentials,
 * then validate the fields. The credential scan runs before field validation so
 * that a file containing both a token and a typo reports the token, which is
 * the one with a security consequence.
 *
 * @param text - The file's contents.
 * @param path - Its absolute path, for the error messages.
 * @returns The configuration.
 * @throws {CliError} `NO_PROJECT`, with a message naming the file and the exact
 *   problem, for malformed JSON, a non-object document, a missing or malformed
 *   `projectId`, a malformed `projectSlug`, or anything credential-shaped.
 */
export function parseRepositoryConfig(text: string, path: string): RepositoryConfig {
  const document = parseJson(text, path);

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw configProblem(path, `it contains ${describeJson(document)}, not a JSON object`);
  }

  const record = document as Record<string, unknown>;

  const credential = findCredential(record, '', 0);
  if (credential !== null) {
    throw new CliError(
      ErrorCode.NO_PROJECT,
      `\`${path}\` contains \`${credential.location}\`, which ${credential.reason}. ` +
        `${REPOSITORY_CONFIG_RELATIVE} is committed to the repository, so it may hold only \`projectId\` and \`projectSlug\`.`,
      {
        hint:
          'Remove it from the file and rotate the secret — it is in the repository history. ' +
          'Credentials belong in `~/.config/agentchat/credentials.json`, which `agentchat login` writes.',
      },
    );
  }

  const rawId = record['projectId'];
  if (rawId === undefined || rawId === null) {
    throw configProblem(path, 'it has no `projectId`');
  }
  if (!ProjectId.is(rawId)) {
    throw configProblem(
      path,
      `its \`projectId\` is ${describeJson(rawId)}, not a project id of the form \`${ProjectId.prefix}<uuidv7>\``,
    );
  }

  return { projectId: rawId, projectSlug: readSlug(record['projectSlug'], path) };
}

/**
 * Validates the optional slug.
 *
 * @param value - Whatever was under `projectSlug`.
 * @param path - The file, for the error message.
 * @returns The slug, or `null` when it was absent.
 * @throws {CliError} `NO_PROJECT` if it is present but not a slug.
 */
function readSlug(value: unknown, path: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || !PROJECT_SLUG_PATTERN.test(value)) {
    throw configProblem(
      path,
      `its \`projectSlug\` is ${describeJson(value)}, which is not a project slug (lower case letters, digits and hyphens, at most 32 characters)`,
    );
  }
  return value;
}

/**
 * Parses JSON, reporting the failure against the file rather than the parser.
 *
 * @param text - The file's contents.
 * @param path - Its absolute path.
 * @returns The parsed document.
 * @throws {CliError} `NO_PROJECT` naming the file and quoting the parser.
 */
function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw configProblem(path, `it is not valid JSON (${reason})`, cause);
  }
}

/**
 * The standard "this file is wrong" failure.
 *
 * @param path - The file.
 * @param problem - What is wrong with it, as a clause following "because".
 * @param cause - The underlying error, if there was one.
 * @returns The error to throw.
 */
function configProblem(path: string, problem: string, cause?: unknown): CliError {
  return new CliError(
    ErrorCode.NO_PROJECT,
    `\`${path}\` is not a usable AgentChat project configuration: ${problem}.`,
    {
      ...(cause === undefined ? {} : { cause }),
      hint: `Delete the file and run \`agentchat project init <slug>\` in that directory to write it again, or pass \`--project <slug>\` for one command.`,
    },
  );
}

/**
 * Renders an untrusted JSON value for an error message, briefly.
 *
 * @param value - The offending value.
 * @returns A short description: `"payments"`, `a number`, `an array`.
 */
function describeJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  if (typeof value === 'string') {
    const text = value.length > 32 ? `${value.slice(0, 32)}…` : value;
    return JSON.stringify(text);
  }
  if (typeof value === 'object') {
    return 'an object';
  }
  return `a ${typeof value}`;
}

/** Something in the document that must not be in a committed file. */
interface CredentialFinding {
  /** Where it is, as a dotted path: `auth.token`. */
  readonly location: string;

  /** Why it is suspect, as a verb phrase: "names a credential". */
  readonly reason: string;
}

/**
 * Key names that may not appear in a committed configuration.
 *
 * Substring matching, case-insensitive, so `githubToken`, `refresh_token` and
 * `TOKEN` are all caught. False positives are possible in principle and are the
 * right trade: the cost of one is a clear error telling the author to rename a
 * field in a file that has two documented keys, and the cost of a miss is a
 * committed secret that nobody noticed.
 */
const CREDENTIAL_KEY_PATTERN =
  /(token|secret|password|passwd|passphrase|credential|apikey|api_key|privatekey|private_key|bearer|jwt|cookie|session|auth)/i;

/** A JSON Web Token: three base64url segments, the first starting `ey`. */
const JWT_PATTERN = /^ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]*$/;

/** GitHub's token prefixes, and the HTTP scheme people paste along with them. */
const TOKEN_PREFIX_PATTERN = /^(gh[pousr]_|github_pat_|bearer\s|basic\s)/i;

/** Characters an opaque secret is made of, and nothing a slug or a URL contains. */
const OPAQUE_PATTERN = /^[A-Za-z0-9+/=_-]{40,}$/;

/**
 * Finds the first credential-shaped thing in a parsed document.
 *
 * Both halves matter. A key check catches `{"githubToken": "…"}` whatever the
 * value looks like; a value check catches `{"note": "eyJhbGciOi…"}`, where the
 * key is innocent and the value is a bearer token. Neither alone is enough.
 *
 * @param value - The value to scan.
 * @param location - The dotted path to it, empty at the root.
 * @param depth - Recursion depth, bounded by {@link MAX_SCAN_DEPTH}.
 * @returns The first finding, or `null` if the document is clean.
 */
function findCredential(value: unknown, location: string, depth: number): CredentialFinding | null {
  if (depth > MAX_SCAN_DEPTH) {
    return null;
  }

  if (typeof value === 'string') {
    const reason = credentialValueReason(value);
    return reason === null ? null : { location: location || '(the whole file)', reason };
  }

  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findCredential(entry, `${location}[${index}]`, depth + 1);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      const here = location === '' ? key : `${location}.${key}`;
      if (CREDENTIAL_KEY_PATTERN.test(key)) {
        return { location: here, reason: 'names a credential' };
      }
      const found = findCredential(entry, here, depth + 1);
      if (found !== null) {
        return found;
      }
    }
  }

  return null;
}

/**
 * Whether a string value looks like a secret, and why.
 *
 * AgentChat identifiers are exempt explicitly: `prj_018f…` is 40 characters of
 * exactly the alphabet {@link OPAQUE_PATTERN} describes, and it is the one
 * value this file is *for*.
 *
 * @param value - The string.
 * @returns The reason it is suspect, or `null`.
 */
function credentialValueReason(value: string): string | null {
  if (ProjectId.is(value) || AgentId.is(value)) {
    return null;
  }
  if (JWT_PATTERN.test(value)) {
    return 'looks like a JSON Web Token';
  }
  if (TOKEN_PREFIX_PATTERN.test(value)) {
    return 'looks like an access token';
  }
  if (OPAQUE_PATTERN.test(value)) {
    return 'is a long opaque value of the kind secrets are made of';
  }
  return null;
}

/**
 * Writes `<directory>/.agentchat/config.json`.
 *
 * Used by `agentchat project init` (T-207). Written atomically — into a
 * temporary file in the same directory, then renamed — so an interrupted write
 * leaves the previous file intact rather than a truncated one that every later
 * command refuses to parse.
 *
 * No mode is forced: this file is committed and read by everyone who can read
 * the repository, so tightening its permissions would suggest a secrecy it does
 * not have.
 *
 * @param directory - The directory to write `.agentchat/` into.
 * @param config - The project identity to record.
 * @returns The absolute path written.
 */
export async function writeRepositoryConfig(
  directory: string,
  config: RepositoryConfig,
): Promise<string> {
  const path = repositoryConfigPath(directory);
  const document: Record<string, string> = { projectId: config.projectId };
  if (config.projectSlug !== null) {
    document['projectSlug'] = config.projectSlug;
  }
  await writeJsonAtomically(path, document, null);
  return path;
}

/**
 * The user's home directory according to an environment.
 *
 * `homedir()` is the last resort rather than the first, because a caller that
 * was handed an environment was handed it on purpose. Reading the process's own
 * home when `HOME` is present in that environment is how {@link userConfigDir}
 * and the credential store came to disagree — see the note on
 * {@link userConfigDir}.
 *
 * @param env - The environment to read.
 * @returns The absolute home directory path.
 */
function homeDirectory(env: Readonly<Record<string, string | undefined>>): string {
  return env['HOME'] ?? env['USERPROFILE'] ?? homedir();
}

/**
 * The directory holding this user's `agentchat` configuration.
 *
 * `$XDG_CONFIG_HOME/agentchat` when that variable is set, otherwise
 * `~/.config/agentchat` as plan §6.1 documents it. Honouring XDG costs one line
 * and is what a user who has moved their configuration expects; the fallback is
 * the documented path on every platform, including Windows, where an explicitly
 * chosen single location is easier to explain than `%APPDATA%` for a tool whose
 * documentation shows Unix paths.
 *
 * ## The one implementation (T-024)
 *
 * This is the *only* function in the CLI that turns an environment into that
 * directory. `./credentials.ts` composes the credentials file out of it rather
 * than computing the directory a second time, because the two copies that used
 * to exist disagreed twice: once on a relative `XDG_CONFIG_HOME`, caught by
 * review, and once on where the home directory comes from, caught by T-209.
 * Both had the same shape — tokens under one directory and user configuration
 * under another, with nothing saying so — and neither could be caught by a test
 * that exercised only one of the pair. Duplication that has to stay in
 * agreement is the bug; deleting it is the fix.
 *
 * @param env - The environment to resolve against. Defaults to `process.env`.
 * @param home - The user's home directory, for a caller that has one from
 *   somewhere other than `env`. Defaults to {@link homeDirectory} of `env`, so
 *   an environment passed here is honoured in full and never half-applied.
 * @returns The absolute directory path.
 */
export function userConfigDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
  home: string = homeDirectory(env),
): string {
  const xdg = env['XDG_CONFIG_HOME'];
  // The XDG specification requires these variables to hold absolute paths and
  // says a relative one must be treated as invalid and ignored. An empty value
  // is likewise "unset" rather than "the root of the filesystem".
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) {
    return join(xdg, USER_CONFIG_DIR);
  }
  return join(home, '.config', USER_CONFIG_DIR);
}

/**
 * The path of this user's `config.json`.
 *
 * @param env - The process environment.
 * @returns The absolute file path.
 */
export function userConfigPath(env: Readonly<Record<string, string | undefined>>): string {
  return join(userConfigDir(env), CONFIG_FILENAME);
}

/**
 * Reads the user configuration.
 *
 * A missing file is not a failure — it is what a new installation looks like —
 * and produces {@link EMPTY_USER_CONFIG}. A file that exists but cannot be
 * parsed *is* a failure: the alternative is to treat it as empty, and the next
 * `agentchat agent use` would then overwrite whatever the user had.
 *
 * Individual malformed entries inside `defaultAgentByProject` are dropped rather
 * than fatal. They can only have come from an older or newer build, and the
 * remedy — choose the agent again — is the same as having no entry at all.
 *
 * @param env - The process environment, which decides the path.
 * @returns The configuration, or {@link EMPTY_USER_CONFIG} if there is none.
 * @throws {CliError} `INTERNAL` if the file exists and is not readable JSON,
 *   naming the path and telling the reader they may delete it.
 */
export async function readUserConfig(
  env: Readonly<Record<string, string | undefined>>,
): Promise<UserConfig> {
  const path = userConfigPath(env);
  const raw = await readUserConfigDocument(path);
  if (raw === null) {
    return EMPTY_USER_CONFIG;
  }

  const serverUrl = raw['serverUrl'];
  const defaults: Record<string, AgentId> = {};
  const stored = raw['defaultAgentByProject'];
  if (typeof stored === 'object' && stored !== null && !Array.isArray(stored)) {
    for (const [projectId, agentId] of Object.entries(stored)) {
      if (ProjectId.is(projectId) && AgentId.is(agentId)) {
        defaults[projectId] = agentId;
      }
    }
  }

  return {
    serverUrl: typeof serverUrl === 'string' && serverUrl !== '' ? serverUrl : null,
    defaultAgentByProject: defaults,
  };
}

/**
 * Reads and parses the user configuration document, if it exists.
 *
 * @param path - The file path.
 * @returns The parsed object, or `null` when the file is absent.
 * @throws {CliError} `INTERNAL` when it exists but cannot be read or parsed.
 */
async function readUserConfigDocument(path: string): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    const code = errnoOf(cause);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw userConfigProblem(path, `it could not be read (${code ?? 'unknown error'})`, cause);
  }

  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (cause) {
    throw userConfigProblem(
      path,
      `it is not valid JSON (${cause instanceof Error ? cause.message : String(cause)})`,
      cause,
    );
  }

  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw userConfigProblem(path, `it contains ${describeJson(document)}, not a JSON object`);
  }
  return document as Record<string, unknown>;
}

/**
 * The standard "your own configuration file is broken" failure.
 *
 * `INTERNAL` (exit 1) rather than `NO_PROJECT`/`NO_AGENT` (exit 4): exit 4 tells
 * a harness to write a project configuration or choose an agent, and doing
 * either would not help while this file is unparseable. The remedy is in the
 * hint, and it is one the reader can act on without understanding any of this.
 *
 * @param path - The file.
 * @param problem - What is wrong with it.
 * @param cause - The underlying error, if any.
 * @returns The error to throw.
 */
function userConfigProblem(path: string, problem: string, cause?: unknown): CliError {
  return new CliError(ErrorCode.INTERNAL, `\`${path}\` could not be used: ${problem}.`, {
    ...(cause === undefined ? {} : { cause }),
    hint: `Fix the file, or delete it — it holds only preferences, and \`agentchat agent use <name>\` writes it again. Your credentials are in a different file and are not affected.`,
  });
}

/**
 * Writes the user configuration, preserving anything this build does not know
 * about.
 *
 * The existing document is read first and the known fields written over it, so
 * a field a newer `agentchat` added is not silently deleted by an older one
 * running `agent use`. Written atomically, and with mode 0600: it holds no
 * secret, but it does say which projects this person works on, and there is no
 * reason for that to be world-readable.
 *
 * @param env - The process environment, which decides the path.
 * @param config - The configuration to store.
 * @returns The absolute path written.
 * @throws {CliError} `INTERNAL` if the existing file cannot be parsed. Merging
 *   into a document that cannot be read is not possible, and overwriting it
 *   would discard whatever the user had.
 */
export async function writeUserConfig(
  env: Readonly<Record<string, string | undefined>>,
  config: UserConfig,
): Promise<string> {
  const path = userConfigPath(env);
  const existing = (await readUserConfigDocument(path)) ?? {};

  const document: Record<string, unknown> = { ...existing };
  if (config.serverUrl === null) {
    delete document['serverUrl'];
  } else {
    document['serverUrl'] = config.serverUrl;
  }
  document['defaultAgentByProject'] = { ...config.defaultAgentByProject };

  await writeJsonAtomically(path, document, 0o600);
  return path;
}

/**
 * Writes a JSON document where an interrupted write cannot corrupt the target.
 *
 * @param path - The file to end up with.
 * @param document - What to write.
 * @param mode - The file mode, or `null` to leave it to the umask.
 */
async function writeJsonAtomically(
  path: string,
  document: unknown,
  mode: number | null,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, ...(mode === null ? {} : { mode: 0o700 }) });

  // Same directory as the target, so the rename is within one filesystem and is
  // therefore atomic. The pid keeps two concurrent processes off each other.
  const temporary = join(directory, `.${CONFIG_FILENAME}.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: 'utf8',
    ...(mode === null ? {} : { mode }),
  });
  await rename(temporary, path);
}

/**
 * The default agent recorded for a project.
 *
 * @param config - The user configuration.
 * @param projectId - The project.
 * @returns The agent id, or `null` if none is recorded.
 */
export function defaultAgentFor(config: UserConfig, projectId: ProjectId): AgentId | null {
  return config.defaultAgentByProject[projectId] ?? null;
}

/**
 * The configuration with one project's default agent set.
 *
 * Pure, so `agentchat agent use` (T-208) reads, transforms, and writes without
 * this module needing to know what it is doing.
 *
 * @param config - The configuration to start from.
 * @param projectId - The project the choice applies to.
 * @param agentId - The agent to make the default.
 * @returns A new configuration; the argument is unchanged.
 */
export function withDefaultAgent(
  config: UserConfig,
  projectId: ProjectId,
  agentId: AgentId,
): UserConfig {
  return {
    ...config,
    defaultAgentByProject: { ...config.defaultAgentByProject, [projectId]: agentId },
  };
}

/**
 * The configuration with one project's default agent removed.
 *
 * @param config - The configuration to start from.
 * @param projectId - The project to forget.
 * @returns A new configuration; the argument is unchanged.
 */
export function withoutDefaultAgent(config: UserConfig, projectId: ProjectId): UserConfig {
  const defaults = { ...config.defaultAgentByProject };
  delete defaults[projectId];
  return { ...config, defaultAgentByProject: defaults };
}
