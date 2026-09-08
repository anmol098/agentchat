/**
 * UUID version 7 (RFC 9562 §5.7): a 48-bit Unix millisecond timestamp followed
 * by 74 bits of counter and randomness.
 *
 * ## Why v7 and not `crypto.randomUUID()`
 *
 * `crypto.randomUUID()` is v4 — uniformly random. AgentChat orders by id:
 * `msg_` identifiers are the tiebreaker for chronological order in the inbox
 * and in conversation replay, and v4 would order them arbitrarily. A v7 id is
 * monotonic in its leading bits, so the lexicographic order of the canonical
 * strings *is* creation order. The same property keeps Postgres from
 * fragmenting the primary-key btree on insert, which v4 does badly.
 *
 * ## Why this is implemented here rather than taken from a package
 *
 * `packages/protocol` is allowed exactly one runtime dependency, zod (task
 * T-005, plan §1). The generator is a page of code over `getRandomValues`;
 * vendoring it costs less than an exemption from that rule, and less than the
 * supply-chain surface of a transitive dependency in the package every other
 * package and the server import.
 *
 * ## Monotonicity
 *
 * Within a single millisecond `Date.now()` cannot order anything, so this uses
 * the dedicated-counter method of RFC 9562 §6.2: the 12-bit `rand_a` field is a
 * counter, seeded randomly in its low 8 bits at the start of each millisecond
 * and incremented for every further id in that millisecond. That leaves at
 * least 3840 increments of headroom; on overflow the generator borrows a
 * millisecond from the future rather than emit an out-of-order id. A clock that
 * steps backwards is handled the same way — the encoded timestamp never
 * decreases within a process.
 *
 * The guarantee is per process. Two processes generating ids in the same
 * millisecond may interleave, which is why nothing in AgentChat treats id order
 * as authoritative across machines; `created_at` is.
 *
 * @module
 */

import { ErrorCode, ProtocolError } from "./errors.js";

/**
 * Regular-expression source for a canonical UUIDv7, unanchored: lowercase,
 * hyphenated, version nibble `7`, RFC 9562 variant bits (`8`, `9`, `a`, `b`).
 *
 * Uppercase and braced spellings are excluded on purpose. Two spellings of one
 * id would compare unequal as `Map` keys, in `Set`s, and in string columns, so
 * the wire admits exactly one.
 *
 * Exported so the prefixed-identifier patterns in `./ids.js` are built from
 * this definition rather than a second copy of it.
 */
export const UUIDV7_PATTERN_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

/** Anchored form of {@link UUIDV7_PATTERN_SOURCE}. */
const UUIDV7_PATTERN = new RegExp(`^${UUIDV7_PATTERN_SOURCE}$`);

/** Characters in a canonical UUID string. */
const UUID_LENGTH = 36;

/** Largest value the 12-bit `rand_a` counter can hold. */
const MAX_COUNTER = 0xfff;

/**
 * Random bytes consumed per identifier: one for the variant byte, seven for the
 * rest of `rand_b`, and one to seed the counter.
 */
const RANDOM_BYTES_PER_ID = 9;

/** Index of the counter seed within the random buffer. */
const COUNTER_SEED_INDEX = 8;

/** Last millisecond an identifier was generated for. Never decreases. */
let lastTimestamp = -1;

/** Counter within {@link lastTimestamp}, occupying `rand_a`. */
let counter = 0;

/** Scratch buffer, refilled on every call. Reused to avoid per-id allocation. */
const randomBuffer = new Uint8Array(RANDOM_BYTES_PER_ID);

/** The identifier under construction. Reused for the same reason. */
const idBytes = new Uint8Array(16);

/**
 * Minimal view of the Web Crypto random source.
 *
 * Declared locally so this package needs neither `lib.dom` nor `@types/node`,
 * and so it runs unchanged in Node (where `crypto` has been global since
 * Node 19) and in a browser.
 */
interface RandomSource {
  getRandomValues<T extends Uint8Array>(array: T): T;
}

/**
 * Reads one byte, refusing to guess if the buffer is somehow short.
 *
 * `noUncheckedIndexedAccess` makes every indexed read `number | undefined`. The
 * indices here are provably in range, but an explicit check is cheaper to trust
 * than a non-null assertion and turns any future refactor that breaks the
 * invariant into a loud failure rather than a `NaN` in an identifier.
 *
 * @param buffer - Buffer to read from.
 * @param index - Index to read.
 * @returns The byte at `index`.
 * @throws {ProtocolError} `INTERNAL` if the index is out of range.
 */
function byteAt(buffer: Uint8Array, index: number): number {
  const value = buffer[index];
  if (value === undefined) {
    throw new ProtocolError(
      ErrorCode.INTERNAL,
      `UUIDv7 buffer underrun at index ${index}.`,
    );
  }
  return value;
}

/**
 * Formats one byte as two lowercase hex digits.
 *
 * @param byte - An integer in `[0, 255]`.
 * @returns Two hex characters.
 */
function hexByte(byte: number): string {
  return (byte + 0x100).toString(16).slice(1);
}

/**
 * Fills {@link randomBuffer} from the platform CSPRNG.
 *
 * @throws {ProtocolError} `INTERNAL` if `globalThis.crypto` is missing, which
 *   would otherwise mean silently generating guessable identifiers.
 */
function fillRandom(): void {
  const source = (globalThis as { crypto?: RandomSource }).crypto;
  if (source === undefined || typeof source.getRandomValues !== "function") {
    throw new ProtocolError(
      ErrorCode.INTERNAL,
      "No Web Crypto implementation: globalThis.crypto.getRandomValues is " +
        "unavailable. AgentChat requires Node >= 22.12 or a browser.",
    );
  }
  source.getRandomValues(randomBuffer);
}

/**
 * Advances the timestamp and counter for one identifier.
 *
 * @returns The millisecond to encode; never less than the previous call's.
 */
function nextTimestamp(): number {
  const seed = byteAt(randomBuffer, COUNTER_SEED_INDEX);
  const now = Date.now();

  if (now > lastTimestamp) {
    lastTimestamp = now;
    counter = seed;
    return lastTimestamp;
  }

  // Same millisecond, or a clock that stepped backwards: hold the timestamp and
  // let the counter carry the ordering.
  counter += 1;
  if (counter > MAX_COUNTER) {
    lastTimestamp += 1;
    counter = seed;
  }
  return lastTimestamp;
}

/**
 * Generates a UUIDv7 in canonical lowercase form.
 *
 * Successive calls in one process produce strictly increasing strings under
 * plain `<`, which is what makes these identifiers usable for ordering.
 *
 * @returns A 36-character canonical UUIDv7, e.g.
 *   `018f6b1a-9c2e-7f3a-8b4d-5e6f70819a2b`.
 * @throws {ProtocolError} `INTERNAL` if the platform has no Web Crypto.
 */
export function uuidv7(): string {
  fillRandom();
  const timestamp = nextTimestamp();

  // unix_ts_ms, 48 bits big-endian. Split at 32 bits because JavaScript bitwise
  // operators are 32-bit; the high half uses arithmetic instead.
  const high = Math.floor(timestamp / 0x1_0000_0000);
  const low = timestamp >>> 0;

  idBytes[0] = (high >>> 8) & 0xff;
  idBytes[1] = high & 0xff;
  idBytes[2] = (low >>> 24) & 0xff;
  idBytes[3] = (low >>> 16) & 0xff;
  idBytes[4] = (low >>> 8) & 0xff;
  idBytes[5] = low & 0xff;

  // ver = 7 in the high nibble, then rand_a holding the 12-bit counter.
  idBytes[6] = 0x70 | ((counter >>> 8) & 0x0f);
  idBytes[7] = counter & 0xff;

  // var = 0b10 in the two high bits, then 62 bits of rand_b.
  idBytes[8] = 0x80 | (byteAt(randomBuffer, 0) & 0x3f);
  for (let index = 1; index < 8; index += 1) {
    idBytes[8 + index] = byteAt(randomBuffer, index);
  }

  let result = "";
  for (let index = 0; index < 16; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) {
      result += "-";
    }
    result += hexByte(byteAt(idBytes, index));
  }
  return result;
}

/**
 * Reports whether a value is a canonical UUIDv7 string.
 *
 * Checks length, canonical lowercase layout, the version nibble, and the
 * variant bits. It cannot check that the embedded timestamp is plausible; use
 * {@link uuidv7Timestamp} for that.
 *
 * @param value - Any value.
 * @returns `true` for a canonical UUIDv7; `false` for anything else, including
 *   an uppercase spelling of one and a valid UUID of another version.
 */
export function isUuidv7(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === UUID_LENGTH &&
    UUIDV7_PATTERN.test(value)
  );
}

/**
 * Extracts the creation time embedded in a UUIDv7.
 *
 * @param value - A canonical UUIDv7 string.
 * @returns Milliseconds since the Unix epoch, on the same scale as
 *   `Date.now()`.
 * @throws {ProtocolError} `BAD_REQUEST` if `value` is not a canonical UUIDv7.
 */
export function uuidv7Timestamp(value: string): number {
  if (!isUuidv7(value)) {
    throw new ProtocolError(
      ErrorCode.BAD_REQUEST,
      `Not a canonical UUIDv7: ${JSON.stringify(value)}`,
    );
  }
  // The first 12 hex digits, skipping the hyphen at index 8.
  return Number.parseInt(`${value.slice(0, 8)}${value.slice(9, 13)}`, 16);
}
