import { describe, expect, it } from 'vitest';

import { MIN_CLIENT_VERSION, PROTOCOL_VERSION } from '../version.js';
import {
  CLIENT_VERSION_HEADER,
  ClientVersionHeaderSchema,
  formatClientVersionHeader,
  GetVersionResponseSchema,
} from './version.js';

describe('GetVersionResponseSchema', () => {
  const response = {
    version: '0.1.0',
    protocolVersion: 1,
    minClientVersion: '0.1.0',
  };

  it('round-trips the handshake', () => {
    expect(GetVersionResponseSchema.parse(response)).toStrictEqual(response);
  });

  it('accepts what this build would actually report', () => {
    // The endpoint reports the constants this server was compiled with; if the
    // schema could not carry them the two halves have already drifted.
    expect(
      GetVersionResponseSchema.parse({
        version: '0.1.0',
        protocolVersion: PROTOCOL_VERSION,
        minClientVersion: MIN_CLIENT_VERSION,
      }),
    ).toStrictEqual({
      version: '0.1.0',
      protocolVersion: PROTOCOL_VERSION,
      minClientVersion: MIN_CLIENT_VERSION,
    });
  });

  it('keeps the protocol version an integer', () => {
    // Plan section 12.4: it names the shape of the conversation, and only a
    // non-additive change moves it. A semver string here would be a category
    // error a client could not compare.
    for (const protocolVersion of ['1', 1.5, 0, -1]) {
      expect(GetVersionResponseSchema.safeParse({ ...response, protocolVersion }).success).toBe(
        false,
      );
    }
  });

  it('rejects a min client version with a range operator', () => {
    // The CLI prints it in "Server requires agentchat >= X.Y.Z" and adds the
    // operator itself; one baked into the value would render twice.
    expect(
      GetVersionResponseSchema.safeParse({ ...response, minClientVersion: '>=0.1.0' }).success,
    ).toBe(false);
  });

  it('requires all three numbers', () => {
    for (const key of Object.keys(response)) {
      const partial: Record<string, unknown> = { ...response };
      delete partial[key];
      expect(GetVersionResponseSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('tolerates a field a newer server added', () => {
    expect(GetVersionResponseSchema.parse({ ...response, commit: 'abc123' })).toStrictEqual(
      response,
    );
  });
});

describe('CLIENT_VERSION_HEADER', () => {
  it('is lowercase, the way Node normalises an incoming header name', () => {
    expect(CLIENT_VERSION_HEADER).toBe('x-agentchat-client');
    expect(CLIENT_VERSION_HEADER).toBe(CLIENT_VERSION_HEADER.toLowerCase());
  });
});

describe('ClientVersionHeaderSchema', () => {
  it('yields the version with the product token stripped', () => {
    expect(ClientVersionHeaderSchema.parse('agentchat/0.1.0')).toBe('0.1.0');
    expect(ClientVersionHeaderSchema.parse('agentchat/1.2.3-rc.1')).toBe('1.2.3-rc.1');
  });

  it('round-trips what formatClientVersionHeader produces', () => {
    // One function and one schema, so a hand-built header cannot drift from
    // what the server will accept.
    for (const version of ['0.1.0', '1.4.0', '2.0.0-beta.1']) {
      expect(ClientVersionHeaderSchema.parse(formatClientVersionHeader(version))).toBe(version);
    }
  });

  it('rejects another product, a bare version, and a malformed one', () => {
    for (const value of ['curl/8.4.0', '0.1.0', 'agentchat/v0.1.0', 'agentchat/', '']) {
      expect(ClientVersionHeaderSchema.safeParse(value).success).toBe(false);
    }
  });
});
