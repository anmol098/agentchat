/**
 * Server configuration, read from the environment and validated once at
 * startup.
 *
 * Nothing else in the server reads `process.env`. A value that is missing or
 * malformed stops the process here, with a message naming the variable and
 * saying what a usable value looks like, rather than surfacing as a confusing
 * failure minutes later under load.
 *
 * ## Secrets are named, never quoted
 *
 * Three of these variables are credentials: `DATABASE_URL` carries a password,
 * `JWT_SECRET` is the signing key for every access token, and
 * `GITHUB_CLIENT_SECRET` authenticates this server to the identity provider. A
 * configuration failure is exactly the moment those are most likely to be
 * pasted into an issue, a CI log or a screenshot, so every rule below is
 * written to report *which* variable is wrong and never *what it says* — see
 * {@link isPostgresUrl}, {@link JWT_SECRET_HELP} and
 * {@link GITHUB_CLIENT_SECRET_HELP}. Do not add a rule whose message
 * interpolates the value, and do not use a zod message that echoes the input.
 */

import { z } from 'zod';
import { MIN_JWT_SECRET_LENGTH } from './auth/tokens.js';

/** One mebibyte, in bytes. */
const MIB = 1024 * 1024;

/**
 * Largest request body Fastify will accept, in bytes.
 *
 * Fixed at 2 MiB by Plan §2: a message is capped at 1 MiB of content (D10) and
 * the JSON envelope around it needs headroom. The WebSocket `maxPayload` is set
 * to the same number by the task that adds the socket, for the same reason.
 * This is not configurable, because a deployment that raised it would accept
 * messages the database rejects.
 */
export const BODY_LIMIT_BYTES = 2 * MIB;

/** Log levels pino accepts, most verbose first. */
const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;

/** A pino log level. */
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Deployment environments the server distinguishes between. */
const NODE_ENVS = ['development', 'test', 'production'] as const;

/** The environment the server believes it is running in. */
export type NodeEnv = (typeof NODE_ENVS)[number];

/**
 * Thrown when the environment does not describe a server that can start.
 *
 * Carries a stable `code` so callers can branch on it without matching message
 * text (Protocol §7.3), and `problems` so a caller can render the failures
 * itself instead of re-parsing `message`.
 */
export class ConfigurationError extends Error {
  /** Stable, machine-readable identifier for this failure. */
  public readonly code = 'CONFIGURATION_INVALID';

  /** One human-readable line per offending variable, each naming the variable. */
  public readonly problems: readonly string[];

  public constructor(problems: readonly string[]) {
    super(
      [
        'The server cannot start: its configuration is invalid.',
        ...problems.map((problem) => `  - ${problem}`),
        '',
        'Set the variables above and start again. For local development:',
        '  docker compose up -d postgres',
        "  export DATABASE_URL='postgres://agentchat:agentchat@localhost:5432/agentchat'",
        '  export JWT_SECRET="$(openssl rand -hex 32)"',
        '  export GITHUB_CLIENT_ID=... GITHUB_CLIENT_SECRET=...   # from a GitHub OAuth app',
      ].join('\n'),
    );
    this.name = 'ConfigurationError';
    this.problems = problems;
  }
}

/**
 * A whole number read from an environment variable, which is always a string.
 *
 * The union accepts a real number too so the schema can be exercised from a
 * plain object in tests without stringifying every field first.
 *
 * @param bounds - Inclusive range the value must fall in.
 * @param fallback - Value used when the variable is absent.
 */
function wholeNumber(bounds: { min: number; max: number }, fallback: number) {
  return z
    .union([z.number(), z.string().regex(/^\d+$/, 'must be a whole number')])
    .transform(Number)
    .pipe(
      z
        .number()
        .int('must be a whole number')
        .min(bounds.min, `must be at least ${bounds.min}`)
        .max(bounds.max, `must be at most ${bounds.max}`),
    )
    .default(fallback);
}

/** Schemes a PostgreSQL connection string may use. */
const POSTGRES_SCHEMES = new Set(['postgres:', 'postgresql:']);

/**
 * Whether a string is a syntactically valid PostgreSQL connection URL.
 *
 * The value itself is never echoed back in an error, because connection
 * strings carry passwords and configuration errors end up in CI logs.
 */
function isPostgresUrl(value: string): boolean {
  try {
    return POSTGRES_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

const DATABASE_URL_HELP =
  'must be a PostgreSQL connection URL, for example ' +
  'postgres://agentchat:agentchat@localhost:5432/agentchat';

/**
 * Help for `JWT_SECRET`.
 *
 * The length floor is {@link MIN_JWT_SECRET_LENGTH}, imported rather than
 * written out: the token service and the authentication plugin both refuse a
 * shorter key, and a second copy of the number here would be a copy nothing
 * checks. HMAC-SHA256 accepts a key of any length and gives a weak one weak
 * security in silence, which is why this is caught at boot or never.
 *
 * The message names the variable and how to make a good value. It cannot name
 * the bad one: this text is what reaches stderr, and stderr is what ends up in
 * a bug report.
 */
const JWT_SECRET_HELP =
  `must be at least ${MIN_JWT_SECRET_LENGTH} characters of unguessable text; ` +
  'generate one with: openssl rand -hex 32';

/**
 * Help for `GITHUB_CLIENT_ID`.
 *
 * A client id is public by design, so echoing it would be harmless. It is still
 * not echoed: "secrets are never quoted" is a rule worth keeping without
 * exceptions, because the next person to add a variable here will copy whatever
 * the neighbouring one does.
 */
const GITHUB_CLIENT_ID_HELP =
  'must be the client id of the GitHub OAuth app this server logs users in with; ' +
  'create one at https://github.com/settings/developers with device flow enabled';

/**
 * Help for `GITHUB_CLIENT_SECRET`.
 *
 * `createGitHubIdentityProvider` treats the secret as optional, because GitHub's
 * device flow does not require an OAuth app to authenticate at the token
 * endpoint. It is required *here* anyway: plan §7 lists it among the server's
 * configuration, every GitHub OAuth app has one, and a deployment that meant to
 * set it and mistyped the variable name should be told at boot rather than
 * discover months later that its token requests were unauthenticated.
 */
const GITHUB_CLIENT_SECRET_HELP =
  'must be the client secret of the same GitHub OAuth app; ' +
  'generate one alongside the client id and keep it out of version control';

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(NODE_ENVS, { error: `must be one of ${NODE_ENVS.join(', ')}` })
    .default('development'),

  DATABASE_URL: z
    .string({ error: DATABASE_URL_HELP })
    .trim()
    .min(1, DATABASE_URL_HELP)
    .refine(isPostgresUrl, DATABASE_URL_HELP),

  // The HS256 signing key for access tokens (plan §7). Deliberately not
  // `.trim()`ed: a secret is opaque bytes and silently rewriting it would make
  // this server disagree with any other tool handed the same value. The refine
  // still measures the trimmed length, so a variable set to 40 spaces is
  // rejected rather than accepted as a 40-character key.
  JWT_SECRET: z
    .string({ error: JWT_SECRET_HELP })
    .refine((secret) => secret.trim().length >= MIN_JWT_SECRET_LENGTH, JWT_SECRET_HELP),

  // The identity provider's credentials (plan §7). Both are required: the
  // provider adapter throws on a blank client id, and failing at boot beats
  // failing on the first login attempt of the day.
  GITHUB_CLIENT_ID: z.string({ error: GITHUB_CLIENT_ID_HELP }).trim().min(1, GITHUB_CLIENT_ID_HELP),

  GITHUB_CLIENT_SECRET: z
    .string({ error: GITHUB_CLIENT_SECRET_HELP })
    .refine((secret) => secret.trim() !== '', GITHUB_CLIENT_SECRET_HELP),

  // 0.0.0.0 rather than localhost: the reference deployment runs the server in
  // a container, where binding the loopback interface makes it unreachable
  // from outside the container with no error to explain why.
  HOST: z.string().trim().min(1, 'must not be empty').default('0.0.0.0'),

  // 0 asks the operating system for a free port, which is what the tests use.
  PORT: wholeNumber({ min: 0, max: 65_535 }, 3000),

  LOG_LEVEL: z
    .enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` })
    .default('info'),

  // Pool sizing is deliberately modest: the reference deployment runs the
  // server and Postgres on one VM (D6), where an idle backend costs about as
  // much as a busy one.
  DATABASE_POOL_MAX: wholeNumber({ min: 1, max: 1000 }, 10),
  DATABASE_CONNECTION_TIMEOUT_MS: wholeNumber({ min: 100, max: 120_000 }, 5_000),
  DATABASE_IDLE_TIMEOUT_MS: wholeNumber({ min: 1_000, max: 3_600_000 }, 30_000),

  // How long a graceful shutdown may take before the process gives up and
  // exits non-zero. Kubernetes and Compose send SIGKILL after their own grace
  // period; this number should stay below it so the server gets to say why.
  SHUTDOWN_TIMEOUT_MS: wholeNumber({ min: 100, max: 120_000 }, 10_000),
});

/** Settings for the database pool, shaped for `createDatabase`. */
export interface DatabaseConfig {
  /** Maximum number of pooled connections. */
  readonly maxConnections: number;
  /** How long to wait for a connection before failing, in milliseconds. */
  readonly connectionTimeoutMillis: number;
  /** How long an unused connection stays open, in milliseconds. */
  readonly idleTimeoutMillis: number;
}

/** Credentials for the identity provider that brokers logins. */
export interface IdentityProviderConfig {
  /** The OAuth app's client id. Public by design; it appears in no response. */
  readonly clientId: string;
  /**
   * The OAuth app's client secret.
   *
   * Sent to the provider's token endpoint and nowhere else. Never log this, and
   * never put it in an error message: `github.ts` scrubs it out of anything it
   * throws, and that guarantee is only as good as its weakest holder.
   */
  readonly clientSecret: string;
}

/** Everything the server needs to know about its environment. */
export interface ServerConfig {
  /** Deployment environment. */
  readonly nodeEnv: NodeEnv;
  /** Interface to bind. */
  readonly host: string;
  /** Port to bind. `0` asks the operating system to choose one. */
  readonly port: number;
  /** Minimum severity pino emits. */
  readonly logLevel: LogLevel;
  /** PostgreSQL connection string. */
  readonly databaseUrl: string;
  /** Connection pool settings. */
  readonly database: DatabaseConfig;
  /**
   * HS256 signing key for access tokens.
   *
   * Held here because the token service and the authentication plugin both need
   * the same value — verification is symmetric. Changing it invalidates every
   * outstanding access token, which is the emergency lever when one is believed
   * stolen.
   */
  readonly jwtSecret: string;
  /** Identity-provider credentials. */
  readonly identityProvider: IdentityProviderConfig;
  /** Largest accepted request body, in bytes. Always {@link BODY_LIMIT_BYTES}. */
  readonly bodyLimitBytes: number;
  /** How long a graceful shutdown may take before the process forces an exit. */
  readonly shutdownTimeoutMs: number;
}

/**
 * Treats a variable set to whitespace as unset.
 *
 * `FOO=` in a Compose file or a shell export produces an empty string, not an
 * absent key. Without this, an empty `DATABASE_URL` would report "must be a
 * PostgreSQL connection URL" when the truthful answer is that it is not set.
 */
function withoutBlanks(env: NodeJS.ProcessEnv): Record<string, string> {
  const entries = Object.entries(env).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== '',
  );

  return Object.fromEntries(entries);
}

/**
 * Reads and validates the server's configuration.
 *
 * @param env - Environment to read. Defaults to `process.env`.
 * @returns A frozen, fully defaulted configuration.
 * @throws {ConfigurationError} If any variable is missing or malformed. The
 * message names every offending variable, so one run reports every problem
 * rather than one per restart.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const result = environmentSchema.safeParse(withoutBlanks(env));

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const variable = issue.path.join('.');
      return variable === '' ? issue.message : `${variable} ${issue.message}`;
    });

    throw new ConfigurationError(problems);
  }

  const parsed = result.data;

  return Object.freeze({
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    databaseUrl: parsed.DATABASE_URL,
    database: Object.freeze({
      maxConnections: parsed.DATABASE_POOL_MAX,
      connectionTimeoutMillis: parsed.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: parsed.DATABASE_IDLE_TIMEOUT_MS,
    }),
    jwtSecret: parsed.JWT_SECRET,
    identityProvider: Object.freeze({
      clientId: parsed.GITHUB_CLIENT_ID,
      clientSecret: parsed.GITHUB_CLIENT_SECRET,
    }),
    bodyLimitBytes: BODY_LIMIT_BYTES,
    shutdownTimeoutMs: parsed.SHUTDOWN_TIMEOUT_MS,
  });
}
