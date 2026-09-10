import { PROTOCOL_VERSION } from '@stackgrid/protocol';
import { describe, expect, it } from 'vitest';

import { PLAIN_PALETTE } from '../output/colour.js';
import { HumanWriter } from '../output/writer.js';
import { CLI_VERSION } from '../version.js';
import { versionCommand, versionView } from './version.js';

describe('versionView', () => {
  it('omits `server` entirely when none was consulted', () => {
    // Absent rather than null, so a consumer tests for the key rather than
    // distinguishing two kinds of nothing.
    expect(versionView().json).toEqual({
      version: CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
    });
  });

  it('reports the server alongside this build when one was', () => {
    const json = versionView({
      version: '9.9.9',
      protocolVersion: 1,
      minClientVersion: '0.1.0',
    }).json;

    expect(json).toEqual({
      version: CLI_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      server: { version: '9.9.9', protocolVersion: 1, minClientVersion: '0.1.0' },
    });
  });

  it('renders the same facts for a human', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    versionView({ version: '9.9.9', protocolVersion: 1, minClientVersion: '0.1.0' }).render(writer);
    const text = writer.toText();

    expect(text).toContain(`agentchat ${CLI_VERSION}`);
    expect(text).toContain('9.9.9');
    expect(text).toContain('minimum client');
  });

  it('leaves the server rows out of the human rendering too', () => {
    const writer = new HumanWriter(PLAIN_PALETTE);
    versionView().render(writer);

    expect(writer.toText()).not.toContain('server');
  });
});

describe('the version command', () => {
  it('takes no positional arguments', () => {
    expect(versionCommand.positionals).toBeUndefined();
  });

  it('declares no options of its own, using the global --server', () => {
    // Every command needs a server, so it is global rather than repeated. The
    // scanner in `../args.ts` depends on that: only a *global* value-taking
    // option can appear before the command name.
    expect(versionCommand.options).toBeUndefined();
  });
});
