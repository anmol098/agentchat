import { describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES, ConfigurationError, loadConfig } from '../src/config.js';

/**
 * Unit tests for configuration loading.
 *
 * `loadConfig` takes the environment as an argument precisely so these tests
 * never touch `process.env`, and so a failure here cannot depend on what the
 * developer happens to have exported.
 */

/** The smallest environment that describes a startable server. */
const MINIMAL = {
  DATABASE_URL: 'postgres://agentchat:agentchat@localhost:5432/agentchat',
} as const;

describe('loadConfig', () => {
  it('accepts an environment carrying only the required variable', () => {
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
  });

  it('fixes the body limit at 2 MiB, as Plan section 2 requires', () => {
    expect(BODY_LIMIT_BYTES).toBe(2 * 1024 * 1024);
    expect(loadConfig({ ...MINIMAL }).bodyLimitBytes).toBe(BODY_LIMIT_BYTES);
  });

  it('names the missing variable when a required one is absent', () => {
    let thrown: unknown;
    try {
      loadConfig({});
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
    expect(() => loadConfig({ DATABASE_URL: '   ' })).toThrow(ConfigurationError);
  });

  it('rejects a DATABASE_URL that is not a PostgreSQL URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'mysql://localhost:3306/agentchat' })).toThrow(
      ConfigurationError,
    );
    expect(() => loadConfig({ DATABASE_URL: 'not a url at all' })).toThrow(ConfigurationError);
  });

  it('never echoes the connection string back in an error', () => {
    const secret = 'postgresql://agentchat:hunter2@db.internal:5432/agentchat?sslmode=require';

    let message = '';
    try {
      // A valid PostgreSQL URL paired with a bad port, so the failure is real
      // but the connection string is not the thing at fault.
      loadConfig({ DATABASE_URL: secret, PORT: '99999' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain('PORT');
    expect(message).not.toContain('hunter2');
  });

  it('reports every offending variable in one pass', () => {
    let problems: readonly string[] = [];
    try {
      loadConfig({ PORT: 'eighty', LOG_LEVEL: 'chatty' });
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
  });
});
