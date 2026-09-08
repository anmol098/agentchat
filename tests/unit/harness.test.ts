import { describe, expect, it } from 'vitest';

/**
 * Sample test for the `unit` project.
 *
 * It exists so the runner wiring is proven rather than assumed: if `pnpm test`
 * ever stops discovering unit tests, this file stops being collected and the
 * gate goes red instead of quietly passing with nothing to run. Delete it once
 * the packages carry real unit tests of their own.
 */
describe('unit test harness', () => {
  it('collects and runs a synchronous test', () => {
    expect(1 + 1).toBe(2);
  });

  it('awaits an asynchronous test before reporting it', async () => {
    await expect(Promise.resolve('ok')).resolves.toBe('ok');
  });
});
