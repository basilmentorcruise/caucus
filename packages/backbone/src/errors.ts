/**
 * The backbone error taxonomy (CAU-4).
 *
 * Mirrors `@caucus/schema`'s `SchemaError` pattern: every backbone error carries
 * a stable, machine-readable string `.code` so callers (the MCP server) can
 * branch on the kind of failure without matching on human-readable messages.
 *
 * Note what is NOT here: a claim *conflict* is not an error. Losing a
 * first-write-wins race is a normal `already_claimed` result from
 * {@link import("./contract.js").Backbone.claim}, not a throw.
 *
 * The backbone never leaks raw `@caucus/schema` errors: a schema
 * `MalformedMessageError` is caught at the boundary and re-thrown as an
 * {@link InvalidMessageError} carrying the same `.issues`.
 */
import { sanitizeErrorFragment, stripControlChars } from "@caucus/schema";

/**
 * Render a (possibly attacker-supplied) channel name for embedding in an error
 * message: strip C0/DEL/C1 control bytes, length-cap the printable name, then
 * quote.
 *
 * Error messages are a *display/serialization surface* — they travel verbatim
 * over the HTTP wire (`wire-errors.ts`) into the requester's context or TTY,
 * and a dirty name is reachable WITHOUT a token via a percent-encoded URL path
 * (`GET /channels/%C2%9B…`). Two hostile inputs ride here: control bytes AND
 * length. `JSON.stringify` alone is not enough: it escapes C0 but NOT DEL
 * (`\x7f`) or the C1 range (`\x80–\x9f`), so quoting alone would let raw C1
 * bytes ride the message (CAU-81; same gap as CAU-73's read-layer fix); and it
 * applies no length bound, so an 8000-char name would yield an 8000-char error
 * (CAU-123). {@link sanitizeErrorFragment} closes both — strip the dangerous
 * bytes (ADR-C12 / `@caucus/schema` `sanitize.ts`) AND cap the visible length,
 * matching the path-segment error surface (`backbone-server` `parseSegments`).
 * It is a no-op for every VALID slug (`^[a-z0-9][a-z0-9-]{0,63}$` admits no
 * control byte and is well under the cap), so the client-side best-effort
 * `extractChannel` reconstruction stays faithful wherever it matters. The
 * structured `.channel` property keeps the name as supplied — consumers must
 * sanitize it before display, like any untrusted field.
 */
function quoteChannelForMessage(channel: string): string {
  return JSON.stringify(sanitizeErrorFragment(channel));
}

/** Base class for every error the backbone throws. */
export class BackboneError extends Error {
  /** Stable, machine-readable error code. */
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "BackboneError";
    this.code = code;
  }
}

/**
 * Thrown when a supplied channel name is not a valid slug
 * (`^[a-z0-9][a-z0-9-]{0,63}$`). Surfaces before any channel lookup.
 */
export class InvalidChannelNameError extends BackboneError {
  /**
   * The rejected channel name (as supplied, untrimmed — may carry control
   * bytes; sanitize before displaying). The `.message` is already stripped.
   */
  readonly channel: string;

  constructor(channel: string) {
    super(
      `Invalid channel name: ${quoteChannelForMessage(channel)} (must match ^[a-z0-9][a-z0-9-]{0,63}$)`,
      "invalid_channel_name",
    );
    this.name = "InvalidChannelNameError";
    this.channel = channel;
  }
}

/** Thrown when an operation targets a channel that does not exist. */
export class UnknownChannelError extends BackboneError {
  /** The (valid-but-absent) channel name. */
  readonly channel: string;

  constructor(channel: string) {
    super(`Unknown channel: ${quoteChannelForMessage(channel)}`, "unknown_channel");
    this.name = "UnknownChannelError";
    this.channel = channel;
  }
}

/** Thrown by `createChannel` when the channel name is already taken. */
export class ChannelExistsError extends BackboneError {
  /** The already-existing channel name. */
  readonly channel: string;

  constructor(channel: string) {
    super(`Channel already exists: ${quoteChannelForMessage(channel)}`, "channel_exists");
    this.name = "ChannelExistsError";
    this.channel = channel;
  }
}

/**
 * Thrown when a cursor is not an integer within `[0, head]`, or when a `limit`
 * argument is supplied but is not a positive integer.
 */
export class InvalidCursorError extends BackboneError {
  /** The rejected cursor value (may be any type). */
  readonly received: unknown;

  constructor(message: string, received: unknown) {
    super(message, "invalid_cursor");
    this.name = "InvalidCursorError";
    this.received = received;
  }
}

/**
 * Thrown when a message fails the boundary checks: schema validation, the body
 * size cap, the `append`/`claim` type rules, or an empty claim target. Wraps a
 * schema `MalformedMessageError` (carrying its `.issues`) so schema errors never
 * leak as their own type.
 */
export class InvalidMessageError extends BackboneError {
  /** Human-readable list of every problem found. */
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    // Strip control bytes from every issue before it reaches a display surface
    // (ADR-C12 / CAU-88). Some issues echo caller content (the unknown-field key
    // forwarded from schema validation) and this array is sent verbatim as the
    // wire `.issues[]` AND joined into `.message`. The strip is intentional and
    // is NOT made redundant by the wire mapping: `in-memory.ts` constructs this
    // error directly and, when CAUCUS_URL is unset, the MCP server runs the
    // backbone IN-PROCESS — that path never traverses the wire, so without the
    // strip here a dirty issue would reach the model's context verbatim.
    const clean = issues.map(stripControlChars);
    super(`Invalid message: ${clean.join("; ")}`, "invalid_message");
    this.name = "InvalidMessageError";
    this.issues = clean;
  }
}

/**
 * Which seatbelt budget a {@link RateLimitedError} bound on (CAU-74):
 * - `"channel"` — the per-`(channel, agent)` posts/minute cap (the original
 *   ADR-C8 limit);
 * - `"global"` — the agent's cross-channel posts/minute cap;
 * - `"create"` — the per-creator channel-creates/minute throttle.
 */
export type RateLimitScope = "channel" | "global" | "create";

/**
 * Thrown by the seatbelt (ADR-C8 / CAU-74) when an agent exceeds a rate
 * budget: the per-agent posts/minute cap on a channel (`scope: "channel"`),
 * the agent's cross-channel global cap (`"global"`), or the per-creator
 * channel-create throttle (`"create"`). All three scopes share the
 * `rate_limited` code (HTTP 429); the message distinguishes them. The message
 * is **actionable** — it states the cap and roughly how long to wait — so a
 * model that hits it can self-correct (batch / back off) rather than
 * retry-spin. It carries no caller content, so it is safe to surface verbatim
 * (ADR-C12).
 */
export class RateLimitedError extends BackboneError {
  /** The posts/min (or creates/min) cap that was exceeded. */
  readonly limit: number;

  /**
   * Roughly how long (ms) until the oldest in-window post ages out and a slot
   * frees up — i.e. how long to wait before posting again.
   */
  readonly retryAfterMs: number;

  /** Which budget bound: per-channel, agent-global, or channel-create. */
  readonly scope: RateLimitScope;

  constructor(
    limit: number,
    retryAfterMs: number,
    scope: RateLimitScope = "channel",
  ) {
    const wait = Math.ceil(retryAfterMs / 1000);
    let message: string;
    switch (scope) {
      case "global":
        message =
          `Rate limit exceeded: at most ${limit} posts/min per agent across all channels. ` +
          `Wait ~${wait}s before posting again, or batch your updates.`;
        break;
      case "create":
        message =
          `Rate limit exceeded: at most ${limit} channel creates/min per owner. ` +
          `Wait ~${wait}s before creating another channel.`;
        break;
      default:
        message =
          `Rate limit exceeded: at most ${limit} posts/min per agent. ` +
          `Wait ~${wait}s before posting again, or batch your updates.`;
    }
    super(message, "rate_limited");
    this.name = "RateLimitedError";
    this.limit = limit;
    this.retryAfterMs = retryAfterMs;
    this.scope = scope;
  }
}

/**
 * Thrown by the seatbelt (ADR-C8) when an agent posts content identical to its
 * own immediately-previous post — a loop. The message NEVER echoes the offending
 * body (ADR-C12): it names the problem and tells the agent to vary or stop, so
 * it is safe to surface verbatim and gives the model a recoverable instruction.
 */
export class DuplicatePostError extends BackboneError {
  constructor() {
    super(
      "Duplicate of your previous post — identical content was just posted. " +
        "Vary the content or stop repeating; do not re-post the same message.",
      "duplicate_post",
    );
    this.name = "DuplicatePostError";
  }
}

/**
 * Thrown when an append (or a would-be granted claim) targets a channel whose
 * log has reached the per-channel message cap (CAU-74). Capacity, not pacing —
 * waiting does not help, so this is NOT a `rate_limited` (HTTP 429): it maps to
 * 409, alongside the other state conflicts. The message names the channel and
 * the cap and never echoes any content (ADR-C12). A claim against an
 * already-claimed target on a full channel still returns `already_claimed`
 * (the ledger answer needs no append).
 */
export class ChannelFullError extends BackboneError {
  /** The full channel's name. */
  readonly channel: string;

  /** The per-channel message cap that was reached. */
  readonly limit: number;

  constructor(channel: string, limit: number) {
    super(
      `Channel is full: ${quoteChannelForMessage(channel)} holds at most ${limit} ${limit === 1 ? "message" : "messages"}. Start a fresh channel to continue.`,
      "channel_full",
    );
    this.name = "ChannelFullError";
    this.channel = channel;
    this.limit = limit;
  }
}

/**
 * Thrown by `createChannel` when the backbone already holds the maximum number
 * of channels (CAU-74). Like {@link ChannelFullError} this is a capacity state
 * (HTTP 409), not pacing. The message states only the cap — no caller content.
 */
export class ChannelLimitError extends BackboneError {
  /** The backbone-wide channel-count cap that was reached. */
  readonly limit: number;

  constructor(limit: number) {
    super(`Channel limit reached: at most ${limit} channels`, "channel_limit");
    this.name = "ChannelLimitError";
    this.limit = limit;
  }
}

/**
 * Which artifact byte budget a {@link ArtifactTooLargeError} bound on (ADR-C14):
 * - `"blob"` — the per-blob 1 MiB upload cap;
 * - `"channel"` — the per-channel 16 MiB total;
 * - `"global"` — the backbone-wide 128 MiB total.
 */
export type ArtifactCapScope = "blob" | "channel" | "global";

/**
 * Thrown when an artifact upload would exceed one of the three cooperative byte
 * caps of the ephemeral evidence store (ADR-C14): the per-blob, per-channel, or
 * global budget. Capacity, not pacing — but unlike {@link ChannelFullError} the
 * HTTP edge maps this to **413** (payload too large), since the upload is a raw
 * byte stream rejected mid-stream once a budget is exceeded. The message states
 * only the cap and the scope — it never echoes any blob content (ADR-C12).
 */
export class ArtifactTooLargeError extends BackboneError {
  /** Which budget was exceeded. */
  readonly scope: ArtifactCapScope;

  /** The cap (bytes) that was exceeded. */
  readonly limit: number;

  constructor(scope: ArtifactCapScope, limit: number) {
    let where: string;
    switch (scope) {
      case "channel":
        where = "this channel's artifact store";
        break;
      case "global":
        where = "the backbone's artifact store";
        break;
      default:
        where = "a single artifact";
    }
    super(
      `Artifact too large: ${where} is capped at ${limit} bytes.`,
      "artifact_too_large",
    );
    this.name = "ArtifactTooLargeError";
    this.scope = scope;
    this.limit = limit;
  }
}

/**
 * Thrown by {@link import("./contract.js").Backbone.putArtifact} when the
 * uploaded bytes do not hash to the content address they were stored under —
 * `sha256(bytes)` ≠ the supplied `:sha256` (ADR-C14). A client/transport
 * integrity fault, mapped to **400** at the HTTP edge. The message names neither
 * digest verbatim beyond the fixed phrasing and never echoes blob content
 * (ADR-C12).
 */
export class ArtifactIntegrityError extends BackboneError {
  constructor() {
    super(
      "Artifact integrity check failed: the uploaded bytes do not match the supplied content address (sha256).",
      "artifact_integrity",
    );
    this.name = "ArtifactIntegrityError";
  }
}
