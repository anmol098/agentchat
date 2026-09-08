import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CLI_VERSION, PROGRAM } from './version.js';

describe('CLI_VERSION', () => {
  it('agrees with package.json', () => {
    // The duplication `./version.ts` explains is only acceptable because this
    // exists. `CLI_VERSION` is what goes in the `X-AgentChat-Client` header and
    // what the server compares to its `minClientVersion`; a stale constant would
    // report the wrong version in every bug report and, after a release that
    // raises the floor, would lock the user out with an UPGRADE_REQUIRED they
    // could not explain.
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'),
    ) as { version: string; bin: Record<string, string> };

    expect(CLI_VERSION).toBe(manifest.version);
    expect(Object.keys(manifest.bin)).toEqual([PROGRAM]);
  });

  it('is a semantic version', () => {
    expect(CLI_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
