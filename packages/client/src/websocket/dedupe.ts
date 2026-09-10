/**
 * Remembering which messages have already been delivered to the consumer.
 *
 * Delivery is at-least-once by design (Plan §4.4): the server commits a message
 * before it attempts to deliver it, replays everything still pending on every
 * `hello`, and marks a message acknowledged only when an `ack` actually
 * arrives. Every one of those choices is what makes a message survive a listener
 * that crashed, a socket that dropped mid-frame, and a recipient that was
 * offline when it was sent. The price is duplicates: if a socket dies between
 * the client sending an `ack` and the server recording it, the message is still
 * pending, and the next `hello` replays it.
 *
 * This module is what makes that price invisible. A duplicate that reaches a
 * coding agent is not a cosmetic problem — it is the same instruction executed
 * twice — so the deduplication happens here, in the client, rather than being
 * left to every consumer to reinvent (PRD §24 additionally tells harnesses to
 * treat `messageId` as an idempotency key, which is the belt to this braces).
 *
 * ## How long the memory has to be
 *
 * Unbounded is a leak: `agentchat listen` is meant to run for weeks, and a set
 * that grows with every message delivered is a process that eventually dies of
 * it. Too short readmits a duplicate. So what actually bounds it?
 *
 * Work backwards from how a duplicate is produced. It can only arrive by
 * replay, and replay only happens at a handshake — the server sends the pending
 * backlog immediately after `hello`, before `ready`. A message is only in that
 * backlog if its acknowledgement never landed, and an acknowledgement is sent
 * the moment its message is delivered. So the message whose ack was lost is
 * always one of the *last* messages the dead connection carried, and its
 * replayed copy arrives at the *front* of the next connection's traffic. The
 * number of distinct messages that can arrive between the original and its
 * duplicate is therefore close to zero, not close to the uptime.
 *
 * {@link DEFAULT_SEEN_CAPACITY} is three orders of magnitude more than that
 * bound requires, costs about 64 KB, and — this is the point — does not grow.
 * Memory is a function of the capacity alone, never of how long the listener has
 * been running or how many messages it has seen.
 *
 * The one case a bounded memory cannot cover is a consumer that never
 * acknowledges anything (`agentchat listen --no-ack`). Then every message stays
 * pending forever and is replayed on every reconnect, and once more than
 * `capacity` distinct messages exist the oldest are readmitted. That is the
 * correct behaviour rather than a gap: a message that was never acknowledged is
 * one the server is *supposed* to keep delivering, and no client-side memory
 * should be able to suppress it permanently.
 *
 * ## Why it is not reset on reconnect
 *
 * The whole purpose is to span a reconnect. A memory cleared when the socket
 * drops would be empty at exactly the moment the replay arrives, which is the
 * only moment it is needed.
 *
 * @module
 */

import { ErrorCode, type MessageId, ProtocolError } from '@stackgrid/protocol';

/**
 * How many message identifiers are remembered by default.
 *
 * See the module note for the derivation. Briefly: a duplicate arrives within a
 * handful of frames of a reconnect, so anything in the hundreds is already
 * sufficient, and 1024 identifiers of about 40 characters cost tens of
 * kilobytes and never more.
 */
export const DEFAULT_SEEN_CAPACITY = 1024;

/**
 * A fixed-size memory of the message identifiers already handed to the
 * consumer.
 *
 * Eviction is first-in-first-out by *first sighting*, not least-recently-used.
 * Re-seeing an identifier does not extend its life: the memory is "the last
 * N distinct messages", which is exactly the property the bound above is
 * argued from, and an LRU would instead keep a never-acknowledged message
 * suppressed indefinitely by the very replays it is supposed to be dropping.
 */
export class SeenMessages {
  readonly #capacity: number;

  /**
   * Insertion-ordered by specification: `Set` iterates in insertion order, so
   * the first value is always the oldest sighting and eviction is O(1) without
   * a second structure to keep in step.
   */
  readonly #seen = new Set<string>();

  /**
   * @param capacity - How many identifiers to remember. Defaults to
   *   {@link DEFAULT_SEEN_CAPACITY}.
   * @throws {ProtocolError} `BAD_REQUEST` if the capacity is not a positive
   *   integer. Zero is refused rather than treated as "no deduplication": a
   *   listener that silently delivered every replay would look like a working
   *   listener until the day a duplicate cost something.
   */
  public constructor(capacity: number = DEFAULT_SEEN_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new ProtocolError(
        ErrorCode.BAD_REQUEST,
        `The deduplication capacity must be a positive integer, got ${capacity}.`,
      );
    }
    this.#capacity = capacity;
  }

  /** How many identifiers are remembered at most. */
  public get capacity(): number {
    return this.#capacity;
  }

  /** How many identifiers are remembered right now. */
  public get size(): number {
    return this.#seen.size;
  }

  /**
   * Records a message and reports whether it is new.
   *
   * @param messageId - The identifier from the `message` frame.
   * @returns `true` if this is the first sighting and the message should be
   *   delivered to the consumer; `false` if it is a duplicate and must not be.
   */
  public admit(messageId: MessageId): boolean {
    if (this.#seen.has(messageId)) {
      return false;
    }

    this.#seen.add(messageId);
    if (this.#seen.size > this.#capacity) {
      const oldest = this.#seen.values().next();
      if (!oldest.done) {
        this.#seen.delete(oldest.value);
      }
    }
    return true;
  }

  /**
   * Whether an identifier is currently remembered.
   *
   * For diagnostics and tests. Use {@link admit} on the delivery path — asking
   * first and recording afterwards is two operations where one will do, and the
   * gap between them is a place for a bug to live.
   *
   * @param messageId - The identifier to look for.
   * @returns `true` if it has been seen and not yet evicted.
   */
  public has(messageId: MessageId): boolean {
    return this.#seen.has(messageId);
  }
}
