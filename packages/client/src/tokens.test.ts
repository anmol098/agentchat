import { ErrorCode, type ProtocolError } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import type { Credentials } from './credentials.js';
import { InMemoryCredentialStore } from './credentials.js';
import { ApiError } from './errors.js';
import { TokenManager } from './tokens.js';

/** A store that counts reads, so the "read every time" contract is testable. */
class CountingStore extends InMemoryCredentialStore {
  public loads = 0;
  public saves = 0;
  public clears = 0;

  public override load(): Promise<Credentials | null> {
    this.loads += 1;
    return super.load();
  }

  public override save(credentials: Credentials): Promise<void> {
    this.saves += 1;
    return super.save(credentials);
  }

  public override clear(): Promise<void> {
    this.clears += 1;
    return super.clear();
  }
}

/** Resolves on the next macrotask, letting every pending microtask drain. */
function settle(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('TokenManager.require', () => {
  it('reads the store on every call rather than caching', async () => {
    const store = new CountingStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    const manager = new TokenManager(store, () => Promise.reject(new Error('unused')));

    await manager.require();
    await manager.require();

    expect(store.loads).toBe(2);
  });

  it('surfaces AUTH_REQUIRED, not a store failure, when nobody has logged in', async () => {
    const manager = new TokenManager(new InMemoryCredentialStore(), () =>
      Promise.reject(new Error('unused')),
    );

    await expect(manager.require()).rejects.toMatchObject({
      code: ErrorCode.AUTH_REQUIRED,
    });
  });
});

describe('TokenManager.renew', () => {
  it('spends the refresh token once and persists both halves of the new pair', async () => {
    const store = new CountingStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    const spent: string[] = [];
    const manager = new TokenManager(store, (refreshToken) => {
      spent.push(refreshToken);
      return Promise.resolve({ accessToken: 'at-2', refreshToken: 'rt-2' });
    });

    const renewed = await manager.renew('at-1');

    expect(spent).toStrictEqual(['rt-1']);
    expect(renewed).toStrictEqual({ accessToken: 'at-2', refreshToken: 'rt-2' });
    await expect(store.load()).resolves.toStrictEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    });
  });

  it('refreshes once for any number of callers that race in the same tick', async () => {
    const store = new InMemoryCredentialStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    let refreshes = 0;
    const manager = new TokenManager(store, async (refreshToken) => {
      refreshes += 1;
      expect(refreshToken).toBe('rt-1');
      await settle();
      return { accessToken: 'at-2', refreshToken: 'rt-2' };
    });

    const results = await Promise.all([
      manager.renew('at-1'),
      manager.renew('at-1'),
      manager.renew('at-1'),
      manager.renew('at-1'),
      manager.renew('at-1'),
    ]);

    expect(refreshes).toBe(1);
    for (const result of results) {
      expect(result.accessToken).toBe('at-2');
    }
  });

  it('does not spend a second token for a 401 that raced a refresh already finished', async () => {
    // The staggered case the single-flight latch alone does not cover: the
    // second request was sent with at-1, but by the time its 401 came back the
    // refresh had completed and the latch was empty again.
    const store = new InMemoryCredentialStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    let refreshes = 0;
    const manager = new TokenManager(store, () => {
      refreshes += 1;
      return Promise.resolve({ accessToken: 'at-2', refreshToken: 'rt-2' });
    });

    await manager.renew('at-1');
    const second = await manager.renew('at-1');

    expect(refreshes).toBe(1);
    expect(second).toStrictEqual({ accessToken: 'at-2', refreshToken: 'rt-2' });
  });

  it('picks up a refresh performed by another process holding the same store', async () => {
    const store = new InMemoryCredentialStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    let refreshes = 0;
    const manager = new TokenManager(store, () => {
      refreshes += 1;
      return Promise.resolve({ accessToken: 'never', refreshToken: 'never' });
    });

    // Somebody else rotated the pair; this manager never saw it happen.
    await store.save({ accessToken: 'at-9', refreshToken: 'rt-9' });

    await expect(manager.renew('at-1')).resolves.toStrictEqual({
      accessToken: 'at-9',
      refreshToken: 'rt-9',
    });
    expect(refreshes).toBe(0);
  });

  it('refreshes again on a later 401, once the first refresh has been spent', async () => {
    const store = new InMemoryCredentialStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    let generation = 1;
    const manager = new TokenManager(store, () => {
      generation += 1;
      return Promise.resolve({
        accessToken: `at-${generation}`,
        refreshToken: `rt-${generation}`,
      });
    });

    await manager.renew('at-1');
    await manager.renew('at-2');

    expect(generation).toBe(3);
  });

  it('clears the store and says how to recover when the refresh token is rejected', async () => {
    const store = new CountingStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    const manager = new TokenManager(store, () =>
      Promise.reject(new ApiError(401, 'AUTH_REQUIRED', 'Refresh token revoked.')),
    );

    await expect(manager.renew('at-1')).rejects.toMatchObject({
      code: ErrorCode.AUTH_REQUIRED,
    });
    expect(store.clears).toBe(1);
    await expect(store.load()).resolves.toBeNull();

    await manager.renew('at-1').catch((error: unknown) => {
      expect((error as ProtocolError).message).toContain('agentchat login');
    });
  });

  it('keeps the credentials when the refresh failed for a reason that is not authentication', async () => {
    const store = new CountingStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    const manager = new TokenManager(store, () =>
      Promise.reject(new ApiError(500, 'INTERNAL', 'Database is down.')),
    );

    await expect(manager.renew('at-1')).rejects.toMatchObject({ code: ErrorCode.INTERNAL });
    expect(store.clears).toBe(0);
    await expect(store.load()).resolves.not.toBeNull();
  });

  it('shares one failure with every caller that joined the same refresh', async () => {
    const store = new InMemoryCredentialStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    let refreshes = 0;
    const manager = new TokenManager(store, async () => {
      refreshes += 1;
      await settle();
      throw new ApiError(401, 'AUTH_REQUIRED', 'Refresh token revoked.');
    });

    const results = await Promise.allSettled([manager.renew('at-1'), manager.renew('at-1')]);

    expect(refreshes).toBe(1);
    expect(results.map((result) => result.status)).toStrictEqual(['rejected', 'rejected']);
  });

  it('lets a later caller try again after a failed refresh, rather than caching the failure', async () => {
    const store = new InMemoryCredentialStore({ accessToken: 'at-1', refreshToken: 'rt-1' });
    let attempts = 0;
    const manager = new TokenManager(store, () => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new ApiError(500, 'INTERNAL', 'Database is down.'))
        : Promise.resolve({ accessToken: 'at-2', refreshToken: 'rt-2' });
    });

    await expect(manager.renew('at-1')).rejects.toThrow(ApiError);
    await expect(manager.renew('at-1')).resolves.toStrictEqual({
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    });
  });
});
