/**
 * The HTTP error wire contract (CAU-5) — shared by the server (which emits it)
 * and the {@link import("./http-client.js").HttpBackbone} client (which
 * reconstructs real {@link BackboneError} subclasses from it).
 *
 * Every error response — whether it originates from a thrown
 * {@link BackboneError}, a transport-level fault (404/405/413/…), or an
 * unexpected internal failure — has exactly this shape:
 *
 * ```json
 * { "error": { "code": "unknown_channel", "message": "…", "issues": ["…"] } }
 * ```
 *
 * `issues` is present only for `invalid_message` (it carries the schema
 * validation problems). The server NEVER leaks an internal message or stack: an
 * unmapped throw is reported as a generic `internal_error` with a fixed message.
 */
import {
  type ArtifactCapScope,
  ArtifactIntegrityError,
  ArtifactTooLargeError,
  BackboneError,
  ChannelExistsError,
  ChannelFullError,
  ChannelLimitError,
  DuplicatePostError,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  RateLimitedError,
  type RateLimitScope,
  UnknownChannelError,
} from "@caucus/backbone";

/**
 * Raised when a write is presented WITHOUT a valid bearer token (CAU-13). This
 * is a TRANSPORT concern — the `@caucus/backbone` contract has no notion of
 * tokens (the in-process backbone trusts its caller), so the error lives here in
 * `backbone-server` rather than in `@caucus/backbone`. The message is a FIXED
 * string and never names the presented token (ADR-C12); "missing" and "invalid"
 * are deliberately collapsed into one message so a `401` is not an oracle that
 * distinguishes a valid-but-unknown token from no token at all.
 *
 * It is a {@link BackboneError} subclass purely so it flows through the same
 * `mapError` / reconstruction machinery as every other wire error; the
 * `HttpBackbone` client reconstructs it from the `unauthorized` code.
 */
export class UnauthorizedError extends BackboneError {
  constructor() {
    super("missing or invalid token", "unauthorized");
    this.name = "UnauthorizedError";
  }
}

/** The body of every error response. */
export interface WireErrorBody {
  readonly error: {
    /** Stable, machine-readable code (e.g. `unknown_channel`). */
    readonly code: string;
    /** Human-readable message. Never an internal/stack string. */
    readonly message: string;
    /** Present only for `invalid_message`: the schema validation problems. */
    readonly issues?: readonly string[];
  };
}

/** A status code paired with the body to send. */
export interface MappedError {
  readonly status: number;
  readonly body: WireErrorBody;
}

/**
 * The generic message used whenever the server must not reveal what actually
 * went wrong (a non-`BackboneError` throw, or a `BackboneError` with an
 * unrecognized code). Fixed string — never the thrown error's `.message`.
 */
const INTERNAL_MESSAGE = "internal server error";

/**
 * Map a thrown {@link BackboneError} `code` to an HTTP status. Unrecognized
 * codes (and non-`BackboneError` throws) map to 500.
 */
function statusForCode(code: string): number {
  switch (code) {
    case "invalid_channel_name":
    case "invalid_message":
    case "invalid_cursor":
    case "artifact_integrity":
      // `artifact_integrity` (ADR-C14): bytes that don't match their content
      // address are a client/transport integrity fault — 400, alongside the
      // other bad-input cases.
      return 400;
    case "unauthorized":
      return 401;
    // An over-cap artifact upload (ADR-C14) is rejected as 413 (payload too
    // large) — the upload is a raw byte stream cut off mid-stream once a budget
    // is exceeded, so 413 is the honest status (not the 409 the count caps use).
    case "artifact_too_large":
      return 413;
    case "unknown_channel":
      return 404;
    // channel_full / channel_limit (CAU-74) are capacity STATE conflicts
    // ("this resource is full"), not pacing — waiting does not free a slot —
    // so they are deliberately 409 alongside channel_exists/duplicate_post,
    // NOT 429.
    case "channel_exists":
    case "duplicate_post":
    case "channel_full":
    case "channel_limit":
      return 409;
    case "rate_limited":
      return 429;
    default:
      return 500;
  }
}

/**
 * Centralized error mapping: turn any thrown value into an HTTP status + wire
 * body. The router does NOT re-validate inputs — the backbone is the single
 * validation authority — so every input-shape failure arrives here as a
 * {@link BackboneError} and is mapped by its `.code`.
 *
 * - A {@link BackboneError} with a known code → its mapped status + its own
 *   `.message`. `issues` is attached only for `invalid_message`.
 * - A {@link BackboneError} with an unknown code → 500 generic (no leak).
 * - Any other throw → 500 generic (no leak): never the real message/stack.
 */
export function mapError(err: unknown): MappedError {
  if (err instanceof BackboneError) {
    const status = statusForCode(err.code);
    // An unknown backbone code is still a server bug from the client's view —
    // do not echo its (possibly internal) message.
    if (status === 500) {
      return {
        status,
        body: { error: { code: "internal_error", message: INTERNAL_MESSAGE } },
      };
    }
    if (err instanceof InvalidMessageError) {
      return {
        status,
        body: {
          error: { code: err.code, message: err.message, issues: err.issues },
        },
      };
    }
    return { status, body: { error: { code: err.code, message: err.message } } };
  }
  return {
    status: 500,
    body: { error: { code: "internal_error", message: INTERNAL_MESSAGE } },
  };
}

/**
 * A code→factory registry for reconstructing the REAL {@link BackboneError}
 * subclass on the client side from a {@link WireErrorBody}. An unrecognized code
 * yields a generic {@link BackboneError} carrying that code, so `.code` is always
 * faithful even for errors this client doesn't model.
 */
export function backboneErrorFromWire(body: WireErrorBody): BackboneError {
  const { code, message, issues } = body.error;
  switch (code) {
    case "invalid_channel_name":
      return new InvalidChannelNameError(extractChannel(message));
    case "unknown_channel":
      return new UnknownChannelError(extractChannel(message));
    case "channel_exists":
      return new ChannelExistsError(extractChannel(message));
    case "invalid_cursor":
      return new InvalidCursorError(message, undefined);
    case "invalid_message":
      return new InvalidMessageError(issues ?? [message]);
    case "rate_limited":
      return rateLimitedFromMessage(message);
    case "duplicate_post":
      return new DuplicatePostError();
    case "channel_full":
      // Channel + limit are best-effort recoveries from the message (like the
      // other reconstructions); instanceof + .code are exact.
      return new ChannelFullError(
        extractChannel(message),
        // `messages?`: the source error pluralizes (`1 message` / `2 messages`).
        extractLimit(message, /holds at most (\d+) messages?/),
      );
    case "channel_limit":
      return new ChannelLimitError(
        extractLimit(message, /at most (\d+) channels/),
      );
    case "artifact_integrity":
      // Fixed-message, value-free (ADR-C14): reconstructed identically.
      return new ArtifactIntegrityError();
    case "artifact_too_large":
      // Recover the scope from the message wording so `instanceof` + `.code` +
      // `.scope` stay faithful; the numeric limit is best-effort like the other
      // capacity reconstructions.
      return new ArtifactTooLargeError(
        artifactCapScopeFromMessage(message),
        extractLimit(message, /capped at (\d+) bytes/),
      );
    case "unauthorized":
      // Fixed-message, value-free: reconstructed identically regardless of why
      // the token was rejected (missing vs unknown — no oracle).
      return new UnauthorizedError();
    default: {
      // Unrecognized code: preserve the code faithfully on a generic error.
      const generic = new BackboneError(message, code);
      return generic;
    }
  }
}

/**
 * Reconstruct a {@link RateLimitedError} from its wire message. The wire carries
 * only the message, so we recover `limit`, the (seconds-rounded) wait, and the
 * CAU-74 `scope` from it and rebuild the error message-faithfully: because the
 * original message rounds `retryAfterMs` up to whole seconds, feeding
 * `seconds * 1000` (and the recovered scope) back through the constructor
 * reproduces the exact same string. `instanceof` + `.code` (what callers branch
 * on) are exact; the numeric `retryAfterMs` and the scope are best-effort.
 * Falls back to `(limit 0, 0ms, "channel")` if the message is unparseable.
 *
 * The limit regex deliberately matches the unit loosely (`[a-z ]+/min`): the
 * three scopes phrase it differently (`posts/min` for channel/global,
 * `channel creates/min` for the create throttle), and a `posts`-only regex
 * would silently reconstruct a create-throttle 429 as `(limit 0, 0ms)`.
 */
function rateLimitedFromMessage(message: string): RateLimitedError {
  const limit = /at most (\d+) [a-z ]+\/min/.exec(message);
  const wait = /Wait ~(\d+)s/.exec(message);
  const limitN = limit?.[1] !== undefined ? Number(limit[1]) : 0;
  const waitS = wait?.[1] !== undefined ? Number(wait[1]) : 0;
  const scope: RateLimitScope = message.includes("across all channels")
    ? "global"
    : message.includes("channel creates/min")
      ? "create"
      : "channel";
  return new RateLimitedError(limitN, waitS * 1000, scope);
}

/**
 * Recover the {@link ArtifactCapScope} from an {@link ArtifactTooLargeError}
 * wire message (ADR-C14). The three scopes phrase the "where" differently
 * ("this channel's artifact store" / "the backbone's artifact store" /
 * "a single artifact"); default to `"blob"` when unrecognized. `.code` +
 * `instanceof` stay exact regardless.
 */
function artifactCapScopeFromMessage(message: string): ArtifactCapScope {
  if (message.includes("channel's artifact store")) return "channel";
  if (message.includes("backbone's artifact store")) return "global";
  return "blob";
}

/**
 * Best-effort numeric recovery for the CAU-74 capacity errors (the wire carries
 * only the message). Falls back to `0` when the message doesn't match —
 * `instanceof` + `.code` stay exact either way.
 */
function extractLimit(message: string, re: RegExp): number {
  const match = re.exec(message);
  return match?.[1] !== undefined ? Number(match[1]) : 0;
}

/**
 * The channel-name-bearing errors store the original name, but the wire only
 * carries the message. These errors are reconstructed for their `instanceof` /
 * `.code` identity (what callers branch on); the embedded `channel` is a
 * best-effort recovery from the message and is not load-bearing.
 */
function extractChannel(message: string): string {
  // Messages are of the form `... : "<name>" ( ... )`. Recover the first quoted
  // token if present; otherwise fall back to the whole message.
  const match = /"((?:[^"\\]|\\.)*)"/.exec(message);
  if (match?.[1] === undefined) {
    return message;
  }
  try {
    return JSON.parse(`"${match[1]}"`) as string;
  } catch {
    return match[1];
  }
}
