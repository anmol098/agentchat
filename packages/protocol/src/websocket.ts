/**
 * The WebSocket close-code vocabulary: every code this server closes a socket
 * with, shared by both halves of the project.
 *
 * ## Why it lives here
 *
 * One wire vocabulary, and until T-052 it was written out twice — `CloseCode`
 * in `server/src/websocket/frames.ts` and `WsCloseCode` in
 * `packages/client/src/websocket/frames.ts`. It drifted twice; the second time,
 * T-048 minted `4429` and the reference client could not name a code it was
 * being sent.
 *
 * The licence boundary was never what forced the duplication. This package is
 * MIT, both halves already depend on it, and {@link ErrorCode} lives here shared
 * rather than transcribed. The codes were duplicated only because nobody had
 * put them here.
 *
 * There is a second reason and it is the stronger one. `pnpm protocol:check`
 * snapshots the exports of *this package* and refuses a removed or renumbered
 * one. T-048 discovered that adding a close code to the server's enum was
 * reported as "the wire contract is unchanged", because the server's enum was
 * not in the snapshot. A close code declared here is covered: adding one is
 * judged additive, and removing or renumbering one fails the check by name.
 * That is enforcement the vocabulary had none of before.
 *
 * ## What is not here
 *
 * `1001` (`GOING_AWAY`) and `1006` (`ABNORMAL`). Both are RFC 6455 §7.4.1
 * codes produced by an intermediary or by the local WebSocket implementation —
 * a browser, a socket library — and never sent by this server. A client has to
 * interpret them, because a build that did not know `1006` could not tell a
 * dropped connection from anything else; a server has no use for them at all.
 * They are therefore declared on the client side, in `LocalCloseCode` there,
 * and this table stays exactly what `docs/protocol.md` §9.6 documents: what the
 * server closes with.
 *
 * ## Changing this table
 *
 * `docs/protocol.md` §9.6 is the human-readable source of truth and the thing a
 * third-party implementer actually reads. Change it in the same pull request:
 * `server/tests/protocol-doc.test.ts` compares that table with this one in both
 * directions and fails if they disagree.
 *
 * Adding a code is additive — both sides must tolerate a close code they do not
 * recognise, and the reference client falls an unknown one through to `retry`
 * by design. Removing or renumbering one is breaking, and `protocol:check` says
 * so.
 *
 * @module
 */

/**
 * Every code this server closes a WebSocket with.
 *
 * Each is a row of `docs/protocol.md` §9.6, which also records the contract
 * code carried by the `error` frame that precedes the close, and what a client
 * should do about each one.
 *
 * The 44xx numbers are in the 4000–4999 range RFC 6455 §7.4.2 reserves for
 * private use, and echo the HTTP status a reader already knows: 4400 reads as
 * 400, 4413 as 413. **The pairing is a mnemonic, not a mapping** — nothing
 * converts between them, and three of these deliberately share one contract
 * code because a client's *remedy* differs while the category it reports to its
 * operator does not.
 *
 * Frozen at runtime, so a consumer cannot mutate the vocabulary it was handed.
 */
export const CloseCode = Object.freeze({
  /** Orderly shutdown by either side. RFC 6455 §7.4.1. */
  NORMAL: 1000,

  /** The server failed while handling a frame. RFC 6455 §7.4.1. */
  INTERNAL_ERROR: 1011,

  /** Not UTF-8, not JSON, or not an object with a string `type`. */
  FRAME_MALFORMED: 4400,

  /** The upgrade carried no usable access token. */
  UNAUTHENTICATED: 4401,

  /** `hello` named a session that is not the caller's, or is not active. */
  SESSION_INVALID: 4403,

  /** A known frame other than `hello` arrived first, or `hello` arrived twice. */
  FRAME_OUT_OF_ORDER: 4409,

  /** The frame exceeded the server's frame-size limit. */
  FRAME_TOO_LARGE: 4413,

  /** A known frame type whose payload failed its schema. */
  FRAME_INVALID: 4422,

  /**
   * The peer stopped reading and its queued backlog passed the server's
   * ceiling (`docs/protocol.md` §9.8).
   *
   * The one 44xx code that names no fault in what was *sent*, which is why it
   * takes `—` in the contract column exactly as 1000 does and arrives with no
   * `error` frame ahead of it. It is separate from 1000 because the remedies
   * are opposite: 1000 means somebody else restarted and there is nothing to
   * fix locally, while this one means the consumer stopped draining its socket
   * and will be dropped again on the next connection unless that is fixed.
   *
   * Transient all the same — the replay on the next `hello` covers everything
   * missed — so a client should reconnect *and* fix the consumer.
   */
  BACKLOG_UNREAD: 4429,
});

/** One of {@link CloseCode}'s values. */
export type CloseCodeValue = (typeof CloseCode)[keyof typeof CloseCode];
