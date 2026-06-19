/**
 * Pure helpers for the read-only SSE log-tail (CAU-17, ADR-C15).
 *
 * `GET /channels/:channel/stream` opens a `text/event-stream` and forwards each
 * NEW log message as one sanitized JSON SSE `data:` frame, driven by a
 * server-internal {@link import("@caucus/backbone").Backbone.readSince} poll
 * loop (the backbone has no server-push primitive — see ADR-C15). It is a HUMAN
 * read-tail, not the deferred real-time SDK (ADR-C4) and not an agent transport:
 * one-directional, write-free, never touching the turn loop.
 *
 * Everything that does NOT need a live socket lives here so it is unit-testable
 * without booting a server: the route match, the `?since` cursor parse, the SSE
 * frame/heartbeat formatting, and the tunable bounds. The socket plumbing (the
 * poll loop, the concurrency cap, teardown) lives in `server.ts`.
 */
import type { AppendedMessage } from "@caucus/backbone";
import { sanitizeMessageFields } from "@caucus/schema";

/**
 * Maximum simultaneously-open streams across the whole server (ADR-C15).
 * Exported and tunable. The stream route is consciously exempt from the CAU-75
 * slowloris timeouts (a held-open stream is the intended behavior), so this cap
 * — not a per-request timeout — is what bounds socket exhaustion from a
 * runaway/buggy client. 32 sits well above plausible honest load on a
 * single-digit-human, loopback-default, single intra-team server (ADR-C9): it
 * caps abuse without rationing honest use. The 33rd concurrent stream is
 * rejected `503` (global capacity, retryable — NOT a per-client `429`).
 */
export const MAX_CONCURRENT_STREAMS = 32;

/**
 * How often the server polls the backbone for new messages on an open stream.
 * ~1s is a deliberate HUMAN cadence (ADR-C15): a passive human viewer does not
 * need sub-second latency, and a tight loop would hammer the backbone. This is
 * the bound AC3 validates delivery against (≤ ~one poll interval).
 */
export const STREAM_POLL_INTERVAL_MS = 1_000;

/**
 * How often an idle stream emits an SSE comment heartbeat (`: keep-alive`).
 * The route is exempt from the keep-alive timeout, so the heartbeat — not a
 * socket timeout — keeps the connection demonstrably live and lets the client
 * (and any intermediary) notice a dead peer. Delivers no data; comment lines
 * are ignored by every SSE parser.
 */
export const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

/** The SSE comment line emitted as a heartbeat on an idle stream. */
export const HEARTBEAT_FRAME = ": keep-alive\n\n";

/** A parsed stream route: `/channels/:channel/stream`. */
export interface StreamRoute {
  readonly channel: string;
}

/**
 * Match `/channels/:channel/stream` against ALREADY-decoded path segments and
 * return the channel, or `undefined` for any other path. Kept segment-based (not
 * string-based) so it shares the percent-decoding + malformed-path handling the
 * JSON router already does in `server.ts`.
 */
export function matchStreamRoute(
  segments: readonly string[],
): StreamRoute | undefined {
  if (
    segments.length === 3 &&
    segments[0] === "channels" &&
    segments[2] === "stream"
  ) {
    return { channel: segments[1] as string };
  }
  return undefined;
}

/**
 * Sentinel returned by {@link parseSince} for a malformed/out-of-bounds `?since`
 * — the caller maps it to a `400 invalid_request`, mirroring `readSince`'s
 * `invalid_cursor`. Distinct from `undefined` (the absent-`since` case, which
 * means "start at head").
 */
export const SINCE_INVALID = Symbol("since_invalid");

/**
 * Parse the optional `?since=<cursor>` query value. Returns:
 * - `undefined` when `since` is absent (⇒ start at the subscribe-minted head);
 * - the integer cursor when it is a non-negative integer (the backbone's
 *   `readSince` re-validates the upper bound `≤ head` and the lower bound);
 * - {@link SINCE_INVALID} when present but not a non-negative integer.
 *
 * This only screens the SHAPE (a non-negative integer, exactly what `readSince`
 * accepts numerically); the backbone remains the authority on the `[0, head]`
 * range. Mirrors the `read` route, which passes the cursor straight to the
 * backbone for the range check.
 */
export function parseSince(raw: string | null): number | undefined | typeof SINCE_INVALID {
  if (raw === null) return undefined;
  if (raw === "") return SINCE_INVALID;
  // Reject anything that is not a base-10 non-negative integer literal (no
  // sign, no decimal, no `0x`, no whitespace) — Number() is too lenient.
  if (!/^\d+$/.test(raw)) return SINCE_INVALID;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) return SINCE_INVALID;
  return n;
}

/**
 * Read the raw `since` query value out of a request URL's query string, or
 * `null` when absent. Lives here (not in `server.ts`) so the parse is testable
 * end-to-end from a URL. Uses the WHATWG `URLSearchParams` against a dummy base
 * so a relative request-target (`/channels/x/stream?since=3`) parses.
 */
export function sinceParam(url: string): string | null {
  const q = url.indexOf("?");
  if (q === -1) return null;
  return new URLSearchParams(url.slice(q + 1)).get("since");
}

/**
 * Format one appended message as an SSE `data:` frame: the SAME field-sanitized
 * JSON `caucus_read_channel` returns (via the SINGLE shared
 * {@link sanitizeMessageFields}, so the two surfaces cannot drift — ADR-C15),
 * wrapped in `data: …\n\n`. The JSON is single-line (`JSON.stringify` with no
 * indent never emits a raw newline — control bytes are stripped/escaped), so it
 * is exactly one SSE `data:` line and needs no multi-line splitting.
 */
export function formatMessageFrame(message: AppendedMessage): string {
  const json = JSON.stringify(sanitizeMessageFields(message));
  return `data: ${json}\n\n`;
}
