/**
 * The implementation-agnostic backbone contract (CAU-4).
 *
 * This is the single interface the MCP server and the integration harness
 * depend on. It hides whether the backbone is the purpose-built in-memory /
 * SQLite implementation or some future adapter (ADR substrate decision). The
 * message *shape* is owned exclusively by `@caucus/schema` — this module never
 * redefines it; it only adds the append-time `ts` stamp and the cursor /
 * channel / claim envelope types the transport layer needs.
 *
 * Normative semantics (claim conflict, cursor advancement, the
 * check-then-append CAS invariant, the error taxonomy) are specified in
 * `docs/BACKBONE_CONTRACT.md`; this file restates the load-bearing parts as
 * TSDoc so they travel with the types.
 */
import type { CaucusMessage, MessageInput } from "@caucus/schema";

/**
 * An opaque, monotonically non-decreasing position in a channel's append-only
 * log. Clients carry it across discrete request/response calls; the backbone is
 * stateless about it (a subscription is just a minted cursor — see
 * {@link Backbone.subscribe}). Numerically it is the count of messages the
 * holder has already observed, but callers MUST treat it as opaque: only the
 * backbone that issued a cursor may interpret it, and the only valid operations
 * are "pass it back to {@link Backbone.readSince}" and "compare two cursors from
 * the same channel for equality/order". Its representation may change when
 * durability lands.
 */
export type Cursor = number;

/**
 * A {@link CaucusMessage} that has been appended to a channel log. Appending is
 * the only operation that stamps `ts`, so on an appended message `ts` is always
 * present (the schema type leaves it optional for the pre-append form). `ts` is
 * a **server-monotonic** stamp: strictly increasing within a channel even under
 * a tight append loop, so it can be used to order messages without consulting
 * the log index. It is an **opaque** stamp, NOT a parseable ISO-8601 instant
 * (`Date.parse(ts)` is `NaN`) — treat it only as an ordering token.
 *
 * **Immutability guarantee.** An appended message is the backbone's stored log
 * record. Implementations MUST return it (and the copies in
 * {@link ReadResult.messages}) such that callers cannot mutate the stored log
 * through the returned reference: the reference implementation deep-freezes the
 * record at append time, so mutating any field (`owner`, `agent_id`, `body`,
 * `ts`, nested `to[]`, …) throws in strict mode and is a no-op otherwise. A
 * durable implementation that hands back fresh per-call rows satisfies the same
 * contract. Do not rely on being able to mutate a returned message.
 */
export type AppendedMessage = CaucusMessage & { readonly ts: string };

/** The result of {@link Backbone.readSince}. */
export interface ReadResult {
  /**
   * The messages appended strictly after the supplied cursor, in append order,
   * capped by the `limit` argument AND the implementation's max page size
   * (CAU-83). Empty when the cursor is already at head.
   * Each element is deeply immutable (see {@link AppendedMessage}'s immutability
   * guarantee): mutating one cannot alter the stored log.
   */
  readonly messages: readonly AppendedMessage[];
  /**
   * The cursor to pass to the next {@link Backbone.readSince} call. Advances by
   * exactly `messages.length`; equals the input cursor when nothing new was
   * returned, so re-reading never duplicates a message.
   */
  readonly cursor: Cursor;
}

/** The result of a successful {@link Backbone.append}. */
export interface AppendResult {
  /** The appended message, with its server-stamped `ts`. */
  readonly message: AppendedMessage;
  /** The channel head after this append (i.e. the previous head + 1). */
  readonly cursor: Cursor;
}

/**
 * The outcome of {@link Backbone.claim}. A claim is NOT an error when it loses;
 * a lost claim is the `already_claimed` outcome carrying the winner's identity.
 *
 * - `granted`: this caller won. The granted `claim` message has been appended to
 *   the log in the *same* atomic step (ADR-C5: single append, never a
 *   dual-write), so it is immediately visible via {@link Backbone.readSince} and
 *   `cursor` is the new head.
 * - `already_claimed`: a prior claim already holds the (normalized) target.
 *   First-write-wins; NO message is appended and the head does not move. `by`
 *   identifies the winning claim.
 */
export type ClaimResult =
  | {
      readonly outcome: "granted";
      readonly message: AppendedMessage;
      readonly cursor: Cursor;
    }
  | {
      readonly outcome: "already_claimed";
      readonly by: {
        readonly agent_id: string;
        readonly owner: string;
        readonly ts: string;
        readonly msg_id: string;
      };
    };

/** A channel's verbosity policy (ADR-C6). Defaults to `quiet`. */
export type Verbosity = "quiet" | "normal" | "chatty";

/**
 * Public description of a channel. `head` is the channel's current cursor; it is
 * a live snapshot at the time of the call, not a frozen value.
 */
export interface ChannelDescriptor {
  /** The channel name (the `^[a-z0-9][a-z0-9-]{0,63}$` slug). */
  readonly channel: string;
  /** Channels are ephemeral in v0 — there is no durable/persistent kind yet. */
  readonly kind: "ephemeral";
  /** Free-text statement of what this war room is investigating. */
  readonly purpose: string;
  /** Posting verbosity policy (ADR-C6). */
  readonly verbosity: Verbosity;
  /** The `owner` (human) on whose behalf the channel was created. */
  readonly created_by: string;
  /** Server-stamped creation time (ISO-8601, server-monotonic). */
  readonly created_ts: string;
  /** Current head cursor (== number of messages appended so far). */
  readonly head: Cursor;
}

/** Options for {@link Backbone.createChannel}. */
export interface CreateChannelOptions {
  /** Desired channel name; validated against `^[a-z0-9][a-z0-9-]{0,63}$`. */
  readonly channel: string;
  /** What this channel is for. Stored verbatim on the descriptor. */
  readonly purpose: string;
  /** The human owner creating the channel. */
  readonly created_by: string;
  /** Posting verbosity; defaults to `quiet` when omitted (ADR-C6). */
  readonly verbosity?: Verbosity;
}

/**
 * The backbone interface the rest of Caucus depends on.
 *
 * Every method validates its inputs at the boundary and throws a
 * {@link BackboneError} subclass on bad input (see `./errors.ts`); schema
 * validation failures are wrapped into `InvalidMessageError` and never leaked as
 * raw `@caucus/schema` errors. The one exception to "errors on failure" is
 * `claim()`, whose *contention* outcome is a normal `already_claimed` result,
 * not a throw.
 *
 * All methods are async so the same contract serves an in-memory implementation
 * and a future durable (SQLite) one without a signature change.
 */
export interface Backbone {
  /**
   * Create a new ephemeral channel and return its descriptor.
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws ChannelExistsError if a channel with that name already exists.
   */
  createChannel(opts: CreateChannelOptions): Promise<ChannelDescriptor>;

  /**
   * Return the current descriptor (including live `head`) for a channel.
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws UnknownChannelError if no such channel exists.
   */
  describeChannel(channel: string): Promise<ChannelDescriptor>;

  /** List descriptors for every existing channel. Never throws. */
  listChannels(): Promise<readonly ChannelDescriptor[]>;

  /**
   * Append a message to a channel's log and stamp its `ts`. This is the path for
   * every non-claim message; `claim`-typed messages MUST go through
   * {@link claim} instead and are rejected here.
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws UnknownChannelError if no such channel exists.
   * @throws InvalidMessageError if the message fails schema validation, exceeds
   *   the body cap, or is a `claim`-typed message.
   */
  append(channel: string, msg: MessageInput): Promise<AppendResult>;

  /**
   * Return messages appended strictly after `cursor`, in order, up to `limit`.
   * `limit` is a REQUEST, not a guarantee: the implementation clamps every
   * page to its max page size (CAU-83 — `maxReadLimit`, default 500 in the
   * reference implementation), so an omitted or over-cap `limit` yields at
   * most one max-sized page, silently — never an error. The returned `cursor`
   * is the position to resume from; it advances by exactly the number of
   * messages returned, so successive reads never overlap or skip. To drain a
   * channel, loop: read from the returned cursor until a page comes back
   * empty (an empty page ⇔ caught up).
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws UnknownChannelError if no such channel exists.
   * @throws InvalidCursorError if `cursor` is not an integer in `[0, head]`, or
   *   if `limit` is supplied and is not a positive integer.
   */
  readSince(
    channel: string,
    cursor: Cursor,
    limit?: number,
  ): Promise<ReadResult>;

  /**
   * Attempt to claim a target, first-write-wins. The ledger key is
   * `normalizeTarget(msg.target)` (trim + Unicode NFC, no case-fold — ADR-C5).
   * On a win,
   * the `claim` message is appended in the same atomic step and the result is
   * `granted`; on contention the result is `already_claimed` with the winner's
   * identity and nothing is appended.
   *
   * This is the ONLY path that writes the claim ledger — `append()` will not
   * accept `claim`-typed messages.
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws UnknownChannelError if no such channel exists.
   * @throws InvalidMessageError if the message fails schema validation, is not
   *   `type:"claim"`, has an empty target, or exceeds the body cap.
   */
  claim(channel: string, msg: MessageInput): Promise<ClaimResult>;

  /**
   * Mint a cursor at the channel's current head. This is a stateless
   * cursor-mint, NOT a server-side subscription: the backbone keeps no
   * per-subscriber state. Messages appended before this call are invisible to a
   * reader starting from the returned cursor; everything appended after is
   * delivered by {@link readSince}.
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws UnknownChannelError if no such channel exists.
   */
  subscribe(channel: string): Promise<Cursor>;
}
