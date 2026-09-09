import { ErrorCode, MessageId, SessionId } from '@agentchat/protocol';
import { describe, expect, it } from 'vitest';

import {
  ackFrame,
  closeDisposition,
  decodeServerFrame,
  errorFrameCode,
  helloFrame,
  PING_FRAME,
  WsCloseCode,
} from './frames.js';

describe('closeDisposition', () => {
  it.each([
    ['a normal close', WsCloseCode.NORMAL],
    ['a server going away', WsCloseCode.GOING_AWAY],
    ['an abnormal close', WsCloseCode.ABNORMAL],
    ['a server fault', WsCloseCode.INTERNAL_ERROR],
    ['an unread backlog', WsCloseCode.BACKLOG_UNREAD],
  ])('retries %s', (_label, code) => {
    // `BACKLOG_UNREAD` is in that list rather than in the fatal one, and the
    // point of naming it was that this stays true: 4429 fell through to `retry`
    // before the member existed, and it must keep doing so, because the server
    // is still holding the replay for the next `hello`.
    expect(closeDisposition(code)).toBe('retry');
  });

  it('refreshes the token on an unauthenticated close', () => {
    expect(closeDisposition(WsCloseCode.UNAUTHENTICATED)).toBe('refresh');
  });

  it.each([
    ['an invalid session', WsCloseCode.SESSION_INVALID],
    ['a malformed frame', WsCloseCode.FRAME_MALFORMED],
    ['an out-of-order frame', WsCloseCode.FRAME_OUT_OF_ORDER],
    ['an oversize frame', WsCloseCode.FRAME_TOO_LARGE],
    ['an invalid frame', WsCloseCode.FRAME_INVALID],
  ])('gives up on %s', (_label, code) => {
    // Backing off and retrying forever against a permanent refusal leaves a
    // process that looks like a working listener and delivers nothing.
    expect(closeDisposition(code)).toBe('fatal');
  });

  it('retries a close code this build has never heard of', () => {
    // The additive rule: a newer server may close with a code this build does
    // not know, and stranding a listener that would have recovered is the worse
    // of the two mistakes.
    expect(closeDisposition(4499)).toBe('retry');
  });
});

describe('client frames', () => {
  it('omits the client identifier when there is none', () => {
    const sessionId = SessionId.generate();

    expect(helloFrame(sessionId)).toEqual({ type: 'hello', sessionId });
    expect(helloFrame(sessionId, 'agentchat/0.1.0')).toEqual({
      type: 'hello',
      sessionId,
      client: 'agentchat/0.1.0',
    });
  });

  it('builds an ack for one message', () => {
    const messageId = MessageId.generate();

    expect(ackFrame(messageId)).toEqual({ type: 'ack', messageId });
  });

  it('has a ping that carries nothing', () => {
    expect(PING_FRAME).toEqual({ type: 'ping' });
  });
});

describe('decodeServerFrame', () => {
  it('accepts a ready frame and defaults a missing pending count', () => {
    const sessionId = SessionId.generate();

    expect(decodeServerFrame({ type: 'ready', sessionId, pending: 3 })).toEqual({
      kind: 'frame',
      frame: { type: 'ready', sessionId, pending: 3 },
    });
    expect(decodeServerFrame({ type: 'ready', sessionId })).toEqual({
      kind: 'frame',
      frame: { type: 'ready', sessionId, pending: 0 },
    });
  });

  it('keeps every field of a message payload it has never heard of', () => {
    // The payload contract belongs to the messages service. This module
    // validates the one field it uses and must not strip the rest, or a client
    // would silently drop fields a newer server added.
    const messageId = MessageId.generate();
    const decoded = decodeServerFrame({
      type: 'message',
      message: { messageId, sender: '@bob/backend', content: 'hi', somethingNew: { deep: 1 } },
    });

    expect(decoded).toEqual({
      kind: 'frame',
      frame: {
        type: 'message',
        message: { messageId, sender: '@bob/backend', content: 'hi', somethingNew: { deep: 1 } },
      },
    });
  });

  it('ignores a frame type it does not know', () => {
    expect(decodeServerFrame({ type: 'presence', agentId: 'agt_x' })).toEqual({
      kind: 'ignored',
      type: 'presence',
    });
  });

  it('rejects a known frame whose payload is wrong', () => {
    const decoded = decodeServerFrame({ type: 'message', message: { messageId: 'not-an-id' } });

    expect(decoded.kind).toBe('invalid');
  });

  it.each([
    ['a string', 'ready'],
    ['an array', [{ type: 'ready' }]],
    ['null', null],
    ['a number', 7],
    ['an object with no type', { sessionId: 'ses_x' }],
    ['an object whose type is not a string', { type: 42 }],
  ])('rejects %s', (_label, value) => {
    expect(decodeServerFrame(value).kind).toBe('invalid');
  });

  it('names shapes and never contents in the detail it reports', () => {
    const decoded = decodeServerFrame({
      type: 'message',
      message: { messageId: 'nope', content: 'a private instruction' },
    });

    expect(decoded.kind === 'invalid' && decoded.detail).not.toContain('private');
  });
});

describe('errorFrameCode', () => {
  it('passes through a code this build knows', () => {
    expect(
      errorFrameCode({ type: 'error', code: ErrorCode.SESSION_INVALID, message: 'gone' }),
    ).toBe(ErrorCode.SESSION_INVALID);
  });

  it('falls back to INTERNAL for a code from a newer server', () => {
    expect(errorFrameCode({ type: 'error', code: 'QUOTA_EXCEEDED', message: 'later' })).toBe(
      ErrorCode.INTERNAL,
    );
  });
});
