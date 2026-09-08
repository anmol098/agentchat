/**
 * The parts of the send path that are decided before a database is involved.
 *
 * `./messages.integration.test.ts` proves the transaction, the authorization
 * composite and the idempotency index. This file covers what can be decided
 * from the request alone — the size limit and the idempotency key's grammar —
 * because those are the two refusals that must happen *without* a round trip,
 * and a test that needed a connection to check them would be testing the
 * opposite of the claim.
 */

import { Buffer } from 'node:buffer';
import { AgentId, ErrorCode, ProjectId, ProtocolError, UserId } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';
import { HTTP_STATUS_BY_ERROR_CODE } from '../errors.js';
import {
  assertSendable,
  contentByteLength,
  MAX_CLIENT_MESSAGE_ID_LENGTH,
  MAX_CONTENT_BYTES,
  type SendMessageRequest,
} from './messages.js';

/**
 * A well-formed send, with anything the test cares about overridden.
 *
 * @param overrides - Fields to replace.
 * @returns A request that passes {@link assertSendable} unless overridden into
 *   failing.
 */
function sendRequest(overrides: Partial<SendMessageRequest> = {}): SendMessageRequest {
  return {
    userId: UserId.generate(),
    projectId: ProjectId.generate(),
    senderAgentId: AgentId.generate(),
    recipientAgentId: AgentId.generate(),
    content: 'ship it',
    clientMessageId: 'cli-0001',
    ...overrides,
  };
}

/**
 * Runs a validation expected to fail and returns the error it threw.
 *
 * @param run - The validation.
 * @returns The `ProtocolError`.
 * @throws {Error} If it passed, or threw something else. Either is a limit that
 *   is not enforced, which must not read as a pass.
 */
function refusal(run: () => void): ProtocolError {
  try {
    run();
  } catch (error: unknown) {
    if (error instanceof ProtocolError) {
      return error;
    }
    throw new Error(`Expected a ProtocolError, got: ${String(error)}`);
  }
  throw new Error('Expected this request to be refused, but it was accepted.');
}

describe('contentByteLength', () => {
  it('counts bytes of UTF-8, not UTF-16 code units', () => {
    // Three characters, one of them outside the BMP. `String.length` says 4
    // because the emoji is a surrogate pair; `octet_length` says 6.
    const content = 'ab🙂';

    expect(content.length).toBe(4);
    expect(contentByteLength(content)).toBe(6);
  });

  it('agrees with Buffer.byteLength for multi-byte content', () => {
    const content = '“ünïcödé” — 漢字';

    expect(contentByteLength(content)).toBe(Buffer.byteLength(content, 'utf8'));
  });

  it('is zero for empty content', () => {
    expect(contentByteLength('')).toBe(0);
  });
});

describe('the content limit', () => {
  it('accepts content of exactly 1 MiB', () => {
    // The boundary is inclusive in the schema (`octet_length(...) <= 1048576`),
    // so it must be inclusive here or the two disagree about one byte.
    const content = 'a'.repeat(MAX_CONTENT_BYTES);

    expect(contentByteLength(content)).toBe(MAX_CONTENT_BYTES);
    expect(() => {
      assertSendable(sendRequest({ content }));
    }).not.toThrow();
  });

  it('refuses one byte over with PAYLOAD_TOO_LARGE', () => {
    const content = 'a'.repeat(MAX_CONTENT_BYTES + 1);

    const error = refusal(() => {
      assertSendable(sendRequest({ content }));
    });

    expect(error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('measures multi-byte content in bytes, so a short string can be too large', () => {
    // Half a MiB of characters, every one of them four bytes: under the limit
    // by `String.length` and over it by `octet_length`. This is the case a
    // UTF-16 count would wave through and the database would then reject with a
    // constraint violation the caller cannot act on.
    const content = '🙂'.repeat(MAX_CONTENT_BYTES / 4 + 1);

    expect(content.length).toBeLessThan(MAX_CONTENT_BYTES);

    const error = refusal(() => {
      assertSendable(sendRequest({ content }));
    });

    expect(error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });

  it('says how large the message actually was, because the remedy depends on it', () => {
    const content = 'a'.repeat(MAX_CONTENT_BYTES + 512);

    const error = refusal(() => {
      assertSendable(sendRequest({ content }));
    });

    expect(error.message).toContain(String(MAX_CONTENT_BYTES + 512));
    expect(error.message).toContain(String(MAX_CONTENT_BYTES));
  });

  it('resolves to 413, the status the contract fixes for this code', () => {
    // The distinctness of the code is the point: a caller branching on
    // PAYLOAD_TOO_LARGE must not have to tell it apart from BAD_REQUEST.
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.PAYLOAD_TOO_LARGE]).toBe(413);
    expect(HTTP_STATUS_BY_ERROR_CODE[ErrorCode.PAYLOAD_TOO_LARGE]).not.toBe(
      HTTP_STATUS_BY_ERROR_CODE[ErrorCode.BAD_REQUEST],
    );
  });

  it('does not object to empty content, because the server does not read it', () => {
    // PRD §3.7: no content inspection. The schema caps the length and sets no
    // floor; inventing one here would be the server having an opinion about
    // what a message means.
    expect(() => {
      assertSendable(sendRequest({ content: '' }));
    }).not.toThrow();
  });
});

describe('the idempotency key', () => {
  it('accepts an ordinary key', () => {
    expect(() => {
      assertSendable(sendRequest({ clientMessageId: '018f2c1e-send-1' }));
    }).not.toThrow();
  });

  it('accepts a key of exactly the maximum length', () => {
    const clientMessageId = 'k'.repeat(MAX_CLIENT_MESSAGE_ID_LENGTH);

    expect(() => {
      assertSendable(sendRequest({ clientMessageId }));
    }).not.toThrow();
  });

  it('refuses an empty key, which would make every send by an agent a duplicate', () => {
    const error = refusal(() => {
      assertSendable(sendRequest({ clientMessageId: '' }));
    });

    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('refuses a key longer than the column accepts', () => {
    const clientMessageId = 'k'.repeat(MAX_CLIENT_MESSAGE_ID_LENGTH + 1);

    const error = refusal(() => {
      assertSendable(sendRequest({ clientMessageId }));
    });

    expect(error.code).toBe(ErrorCode.BAD_REQUEST);
  });

  it('is opaque: the server does not require a particular shape', () => {
    // The CLI picks the format. Constraining it here would be a contract this
    // module has no standing to add, and would break a client that used, say,
    // a hash instead of a uuid.
    for (const clientMessageId of ['1', 'a b c', '../etc/passwd', '🙂', 'UPPER_case-99']) {
      expect(() => {
        assertSendable(sendRequest({ clientMessageId }));
      }).not.toThrow();
    }
  });
});

describe('what local validation discloses', () => {
  it('refuses on request-only facts, so it is safe to run before authorization', () => {
    // Both refusals below are decided from values the caller already holds. If
    // either depended on a project, an agent, or a stored message, running it
    // first would leak whether those exist — and running it last would mean a
    // 1 MiB body costs three queries before it is thrown away.
    const stranger = sendRequest({
      userId: UserId.generate(),
      projectId: ProjectId.generate(),
      content: 'a'.repeat(MAX_CONTENT_BYTES + 1),
    });
    const member = sendRequest({ content: 'a'.repeat(MAX_CONTENT_BYTES + 1) });

    expect(
      refusal(() => {
        assertSendable(stranger);
      }).message,
    ).toBe(
      refusal(() => {
        assertSendable(member);
      }).message,
    );
  });
});
