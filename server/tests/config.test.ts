import { describe, expect, it } from 'vitest';
import { MIN_JWT_SECRET_LENGTH } from '../src/auth/tokens.js';
import { BODY_LIMIT_BYTES, ConfigurationError, loadConfig } from '../src/config.js';

/**
 * Unit tests for configuration loading.
 *
 * `loadConfig` takes the environment as an argument precisely so these tests
 * never touch `process.env`, and so a failure here cannot depend on what the
 * developer happens to have exported.
 */

/** A signing key of exactly the minimum accepted length. */
const JWT_SECRET = 'j'.repeat(MIN_JWT_SECRET_LENGTH);

/** The smallest environment that describes a startable server. */
const MINIMAL = {
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
  JWT_SECRET,
  GITHUB_CLIENT_ID: 'Iv1.0123456789abcdef',
  GITHUB_CLIENT_SECRET: 'ghs_0123456789abcdefghijklmnopqrstuvwxyz',
} as const;

/**
 * The message `loadConfig` produced for an environment, or '' if it accepted it.
 *
 * Used by the tests that assert what a failure does *not* say. They matter more
 * than they look: a configuration failure is the moment a secret is most likely
 * to be pasted into an issue or a CI log.
 */
function failureMessage(env: NodeJS.ProcessEnv): string {
  try {
    loadConfig(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return '';
}

describe('loadConfig', () => {
  it('accepts an environment carrying only the required variables', () => {
    const config = loadConfig({ ...MINIMAL });

    expect(config.databaseUrl).toBe(MINIMAL.DATABASE_URL);
    expect(config.nodeEnv).toBe('development');
    expect(config.host).toBe('0.0.0.0');
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.database).toEqual({
      maxConnections: 10,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
    expect(config.shutdownTimeoutMs).toBe(10_000);
    expect(config.jwtSecret).toBe(JWT_SECRET);
    expect(config.identityProvider).toEqual({
      clientId: MINIMAL.GITHUB_CLIENT_ID,
      clientSecret: MINIMAL.GITHUB_CLIENT_SECRET,
    });
  });

  it('fixes the body limit at 2 MiB, as Plan section 2 requires', () => {
    expect(BODY_LIMIT_BYTES).toBe(2 * 1024 * 1024);
    expect(loadConfig({ ...MINIMAL }).bodyLimitBytes).toBe(BODY_LIMIT_BYTES);
  });

  it('names the missing variable when a required one is absent', () => {
    let thrown: unknown;
    try {
      loadConfig({ ...MINIMAL, DATABASE_URL: undefined });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ConfigurationError);
    const error = thrown as ConfigurationError;

    expect(error.code).toBe('CONFIGURATION_INVALID');
    expect(error.problems).toHaveLength(1);
    expect(error.problems[0]).toContain('DATABASE_URL');
    // The message has to be actionable on its own: the variable, what a good
    // value looks like, and how to get one locally.
    expect(error.message).toContain('DATABASE_URL');
    expect(error.message).toContain('postgres://');
    expect(error.message).toContain('docker compose up -d postgres');
  });

  it('treats a variable set to whitespace as unset', () => {
    expect(() => loadConfig({ ...MINIMAL, DATABASE_URL: '   ' })).toThrow(ConfigurationError);
  });

  it('rejects a DATABASE_URL that is not a PostgreSQL URL', () => {
    expect(() =>
      loadConfig({ ...MINIMAL, DATABASE_URL: 'mysql://localhost:3306/agentchat' }),
    ).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...MINIMAL, DATABASE_URL: 'not a url at all' })).toThrow(
      ConfigurationError,
    );
  });

  it('never echoes the connection string back in an error', () => {
    const secret = 'postgresql://agentchat:hunter2@db.internal:5432/agentchat?sslmode=require';

    // A valid PostgreSQL URL paired with a bad port, so the failure is real but
    // the connection string is not the thing at fault.
    const message = failureMessage({ ...MINIMAL, DATABASE_URL: secret, PORT: '99999' });

    expect(message).toContain('PORT');
    expect(message).not.toContain('hunter2');
  });

  it('reports every offending variable in one pass', () => {
    let problems: readonly string[] = [];
    try {
      loadConfig({ ...MINIMAL, DATABASE_URL: undefined, PORT: 'eighty', LOG_LEVEL: 'chatty' });
    } catch (error) {
      problems = error instanceof ConfigurationError ? error.problems : [];
    }

    // Restarting once per bad variable is a miserable way to configure a
    // server, so one run has to surface all of them.
    expect(problems.join('\n')).toContain('DATABASE_URL');
    expect(problems.join('\n')).toContain('PORT');
    expect(problems.join('\n')).toContain('LOG_LEVEL');
  });

  it('parses numeric variables out of their string form', () => {
    const config = loadConfig({
      ...MINIMAL,
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '8080',
      LOG_LEVEL: 'warn',
      DATABASE_POOL_MAX: '25',
      DATABASE_CONNECTION_TIMEOUT_MS: '1500',
      DATABASE_IDLE_TIMEOUT_MS: '60000',
      SHUTDOWN_TIMEOUT_MS: '2500',
    });

    expect(config).toMatchObject({
      nodeEnv: 'production',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'warn',
      shutdownTimeoutMs: 2_500,
      database: {
        maxConnections: 25,
        connectionTimeoutMillis: 1_500,
        idleTimeoutMillis: 60_000,
      },
    });
  });

  it('rejects numbers that are out of range or not whole', () => {
    expect(() => loadConfig({ ...MINIMAL, PORT: '70000' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...MINIMAL, PORT: '-1' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...MINIMAL, PORT: '80.5' })).toThrow(ConfigurationError);
    expect(() => loadConfig({ ...MINIMAL, DATABASE_POOL_MAX: '0' })).toThrow(ConfigurationError);
  });

  it('allows port 0, which asks the operating system to choose one', () => {
    expect(loadConfig({ ...MINIMAL, PORT: '0' }).port).toBe(0);
  });

  it('returns a frozen configuration so no caller can rewrite it later', () => {
    const config = loadConfig({ ...MINIMAL });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
    expect(Object.isFrozen(config.identityProvider)).toBe(true);
  });
});

/**
 * The authentication variables (T-019).
 *
 * Two properties, and the second is the one worth the file space. The first is
 * ordinary: each is required, and a bad one names itself. The second is that a
 * failure must never quote the value — `JWT_SECRET` signs every access token
 * this server issues and `GITHUB_CLIENT_SECRET` authenticates it to the
 * identity provider, and the output of a failed boot is precisely the text a
 * frustrated operator pastes into an issue.
 */
describe('loadConfig and the authentication variables', () => {
  it('requires JWT_SECRET and names it when it is absent', () => {
    const message = failureMessage({ ...MINIMAL, JWT_SECRET: undefined });

    expect(message).toContain('JWT_SECRET');
    // Actionable: how long, and how to produce one.
    expect(message).toContain(String(MIN_JWT_SECRET_LENGTH));
    expect(message).toContain('openssl rand -hex 32');
  });

  it('rejects a JWT_SECRET too short to be worth signing with', () => {
    const short = 'x'.repeat(MIN_JWT_SECRET_LENGTH - 1);

    // HMAC-SHA256 takes a key of any length and gives a weak one weak security
    // in silence. Boot is the only place this can be caught.
    expect(() => loadConfig({ ...MINIMAL, JWT_SECRET: short })).toThrow(ConfigurationError);
    expect(loadConfig({ ...MINIMAL, JWT_SECRET: `${short}x` }).jwtSecret).toBe(`${short}x`);
  });

  it('measures the trimmed length but keeps the secret exactly as it was given', () => {
    // A key is opaque bytes: trimming it would make this server disagree with
    // whatever else was handed the same value. Padding it out with spaces must
    // not buy a caller a shorter key, though.
    expect(() => loadConfig({ ...MINIMAL, JWT_SECRET: ' '.repeat(64) })).toThrow(
      ConfigurationError,
    );

    const padded = ` ${'k'.repeat(MIN_JWT_SECRET_LENGTH)} `;
    expect(loadConfig({ ...MINIMAL, JWT_SECRET: padded }).jwtSecret).toBe(padded);
  });

  it('requires both halves of the identity provider credential', () => {
    expect(failureMessage({ ...MINIMAL, GITHUB_CLIENT_ID: undefined })).toContain(
      'GITHUB_CLIENT_ID',
    );
    expect(failureMessage({ ...MINIMAL, GITHUB_CLIENT_SECRET: undefined })).toContain(
      'GITHUB_CLIENT_SECRET',
    );
    // The provider adapter throws on a blank client id. Better here, at boot,
    // than on the first login of the day.
    expect(failureMessage({ ...MINIMAL, GITHUB_CLIENT_ID: '   ' })).toContain('GITHUB_CLIENT_ID');
  });

  it('never echoes a secret back, whichever variable is at fault', () => {
    const jwtSecret = 'correct-horse-battery-staple-correct-horse';
    const clientSecret = 'ghs_thisisthegithubclientsecretdonotprint';

    // Every failure the secrets could ride along with: their own, each other's,
    // and an unrelated variable's.
    const messages = [
      failureMessage({ ...MINIMAL, JWT_SECRET: jwtSecret, GITHUB_CLIENT_SECRET: clientSecret }),
      failureMessage({
        ...MINIMAL,
        JWT_SECRET: jwtSecret,
        GITHUB_CLIENT_SECRET: clientSecret,
        PORT: '99999',
      }),
      failureMessage({ ...MINIMAL, JWT_SECRET: 'too-short', GITHUB_CLIENT_SECRET: clientSecret }),
      failureMessage({ ...MINIMAL, JWT_SECRET: jwtSecret, GITHUB_CLIENT_SECRET: '  ' }),
    ];

    for (const message of messages) {
      expect(message).not.toContain(jwtSecret);
      expect(message).not.toContain(clientSecret);
      expect(message).not.toContain('too-short');
    }

    // The first is a valid environment; the rest must have failed, or this test
    // would pass by never producing a message at all.
    expect(messages[0]).toBe('');
    expect(messages.slice(1).every((message) => message !== '')).toBe(true);
  });
});
