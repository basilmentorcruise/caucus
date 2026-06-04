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
