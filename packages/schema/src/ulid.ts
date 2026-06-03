/**
 * Hand-rolled ULID support, zero runtime dependencies (node:crypto only).
 *
 * A ULID is 26 chars of Crockford base32: a 48-bit millisecond timestamp
 * (10 chars) followed by 80 bits of randomness (16 chars). Crockford base32
 * excludes the letters I, L, O and U.
 */
import { randomBytes } from "node:crypto";

/** Crockford base32 alphabet (no I, L, O, U). */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Shape check for a ULID string: 26 Crockford-base32 chars. */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** True iff `s` is a string with valid ULID shape. */
export function isUlid(s: unknown): boolean {
  return typeof s === "string" && ULID_RE.test(s);
}

/** Encode the low `count` chars of a number as Crockford base32 (big-endian). */
function encodeTime(timeMs: number, count: number): string {
  let out = "";
  let n = timeMs;
  for (let i = 0; i < count; i++) {
    const mod = n % 32;
    out = CROCKFORD[mod] + out;
    n = (n - mod) / 32;
  }
  return out;
}

/** Encode `count` random chars of Crockford base32 from CSPRNG bytes. */
function encodeRandom(count: number): string {
  const bytes = randomBytes(count);
  let out = "";
  for (let i = 0; i < count; i++) {
    // Map each byte into the 32-char alphabet (top 5 bits).
    out += CROCKFORD[bytes[i]! % 32];
  }
  return out;
}

/**
 * Generate a fresh ULID: 10-char millisecond timestamp + 16 random chars.
 * Monotonicity within a millisecond is not guaranteed (not needed in v0);
 * the backbone is the single writer and stamps ordering via `ts`/append.
 */
export function newMsgId(): string {
  return encodeTime(Date.now(), 10) + encodeRandom(16);
}
