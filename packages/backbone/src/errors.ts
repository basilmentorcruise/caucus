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
  /** The rejected channel name (as supplied, untrimmed). */
  readonly channel: string;

  constructor(channel: string) {
    super(
      `Invalid channel name: ${JSON.stringify(channel)} (must match ^[a-z0-9][a-z0-9-]{0,63}$)`,
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
    super(`Unknown channel: ${JSON.stringify(channel)}`, "unknown_channel");
    this.name = "UnknownChannelError";
    this.channel = channel;
  }
}

/** Thrown by `createChannel` when the channel name is already taken. */
export class ChannelExistsError extends BackboneError {
  /** The already-existing channel name. */
  readonly channel: string;

  constructor(channel: string) {
    super(`Channel already exists: ${JSON.stringify(channel)}`, "channel_exists");
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
    super(`Invalid message: ${issues.join("; ")}`, "invalid_message");
    this.name = "InvalidMessageError";
    this.issues = issues;
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
      `Channel is full: ${JSON.stringify(channel)} holds at most ${limit} messages. Start a fresh channel to continue.`,
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
    super(`channel limit reached: at most ${limit} channels`, "channel_limit");
    this.name = "ChannelLimitError";
    this.limit = limit;
  }
}
