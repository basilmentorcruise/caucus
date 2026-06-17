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
 * Default per-message body render budget for a channel's injected delta (CAU-94).
 * The hook (`@caucus/hook`'s `renderBody`) elides each message body to this many
 * characters and appends a `+truncated, N chars — caucus_read_channel`
 * affordance. It is the value of `200` the hook previously hard-coded as
 * `BODY_TRUNCATE_CHARS`, kept as the default so the calm feed (ADR-C6) is
 * byte-identical to before; a channel may raise it via
 * {@link CreateChannelOptions.renderBudgetChars} up to the overall delta cap.
 */
export const DEFAULT_RENDER_BUDGET_CHARS = 200 as const;

/**
 * Per-blob upload cap for the ephemeral evidence store (ADR-C14): a single
 * artifact PUT may carry at most 1 MiB of bytes. The HTTP edge enforces this
 * INCREMENTALLY (overflow-and-destroy → `413` mid-stream, mirroring the JSON
 * `MAX_BODY_BYTES` pattern) so a hostile/accidental gigabyte upload is never
 * fully buffered; {@link Backbone.putArtifact} enforces it again on the
 * assembled buffer as the single in-process authority. A cooperative bound, not
 * a defense against a hostile valid-token holder (see SECURITY.md / CAU-74/83).
 */
export const MAX_ARTIFACT_BYTES = 1_048_576 as const;

/**
 * Per-channel total cap for the ephemeral evidence store (ADR-C14): the sum of
 * all DISTINCT blob sizes stored against one channel may not exceed 16 MiB.
 * Dedup means re-uploading identical bytes does not re-charge this budget. A
 * cooperative bound (CAU-74/83); over-cap PUT → `413`.
 */
export const MAX_CHANNEL_ARTIFACT_BYTES = 16_777_216 as const;

/**
 * Backbone-wide total cap for the ephemeral evidence store (ADR-C14): the sum of
 * all DISTINCT blob sizes across every channel may not exceed 128 MiB. Dedup
 * (per-channel) means a blob counts once per channel it is stored in. A
 * cooperative bound (CAU-74/83); over-cap PUT → `413`.
 */
export const MAX_TOTAL_ARTIFACT_BYTES = 134_217_728 as const;

/** The result of a successful {@link Backbone.putArtifact}. */
export interface PutArtifactResult {
  /**
   * The logical, host-agnostic artifact URI `caucus://artifact/<channel>/<sha256>`
   * suitable for the `artifact` field of a message. Resolved CLIENT-SIDE to the
   * fetcher's own validated `CAUCUS_URL` at fetch time — never a caller-supplied
   * host (ADR-C14, no new SSRF surface).
   */
  readonly uri: string;
  /** The content address (lowercase hex SHA-256 of the bytes). */
  readonly sha256: string;
  /** The blob size in bytes. */
  readonly size: number;
  /**
   * `true` when these exact bytes were already stored for this channel (dedup):
   * the store was a no-op and the byte totals did not move. `false` when this
   * call stored a new blob. The HTTP edge maps `false → 201`, `true → 200`.
   */
  readonly deduplicated: boolean;
}

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
 * The outcome of {@link Backbone.claim} / {@link Backbone.reassignClaim} /
 * {@link Backbone.markClaimDone}. A claim is NOT an error when it loses; a lost
 * claim is the `already_claimed` outcome carrying the holder's identity.
 *
 * - `granted`: this caller won (CAU-4 + CAU-18). The appended message — a fresh
 *   `claim`, a heartbeat renew, a reassignment to the new holder, or a
 *   `status:"resolved"` done — has been appended to the log in the *same* atomic
 *   step (ADR-C5: single append, never a dual-write), so it is immediately
 *   visible via {@link Backbone.readSince} and `cursor` is the new head.
 *   `granted` is reused for every successful transition (no per-transition
 *   variant), since the appended `message` already distinguishes them.
 * - `already_claimed`: a LIVE claim already holds the (normalized) target by a
 *   different holder. First-write-wins; NO message is appended and the head does
 *   not move. `by` identifies the holding claim. (A LAPSED lease does not produce
 *   this — it frees the target, so the next claim is `granted`.)
 * - `not_held` (CAU-18): a privileged transition ({@link Backbone.markClaimDone})
 *   targeted a key with NO live lease the caller holds (unheld, never-claimed, or
 *   already lapsed). A NO-OP: nothing is appended, the head does not move, and the
 *   ledger is untouched. The caller cannot "finish" a claim it does not hold.
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
    }
  | {
      readonly outcome: "not_held";
    };

/**
 * The new holder a {@link Backbone.reassignClaim} hands a live target to
 * (CAU-18). These are the anchored identity fields (ADR-C7) that the appended
 * reassignment `claim` message is authored AS, so the ledger record and the
 * visible message agree on who now owns the target. The CALLER's identity (on
 * the `msg` passed to `reassignClaim`) is the *authorizer* matched against the
 * current holder; it is not stored.
 */
export interface ClaimAssignee {
  /** Stable id of the agent the target is being handed to. */
  readonly agent_id: string;
  /** The human the new holder acts for (the anchored owner, ADR-C7). */
  readonly owner: string;
}

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
  /**
   * Per-message body render budget for the injected hook delta (CAU-94):
   * the hook elides each message body to this many characters and appends a
   * `+truncated, N chars — caucus_read_channel` affordance. Defaults to
   * {@link DEFAULT_RENDER_BUDGET_CHARS} (the calm-feed default, ADR-C6); raising
   * it lets evidence-heavy channels surface more body inline.
   */
  readonly renderBudgetChars: number;
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
  /**
   * Per-message body render budget for the injected hook delta (CAU-94). Omitted
   * ⇒ {@link DEFAULT_RENDER_BUDGET_CHARS}. Validated as an integer clamped to
   * `[1, INJECTED_DELTA_CAP_CHARS]`.
   */
  readonly renderBudgetChars?: number;
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
   * Hand a LIVE claim to a new holder, first-write-wins-preserving (CAU-18, the
   * ADR-C5 reassignment transition). Authorization matches the CURRENT holder on
   * the anchored `owner` (ADR-C7 — the human, not the session `agent_id`), so a
   * human may reassign across their own sessions; a different `agent_id` with the
   * same `owner` is allowed, a different `owner` is not.
   *
   * `msg` is a `claim`-typed message carrying the CALLER's anchored identity (the
   * authorizer) and the `target`. `assignee` is the new holder. On success a
   * `claim` message authored AS THE ASSIGNEE is appended in the same atomic step
   * (so the ledger record and the visible message agree) and the result is
   * `granted` with that message; the ledger now points at the assignee.
   *
   * Outcomes:
   * - `granted` — the caller held the live lease (or the target was unheld /
   *   lapsed, in which case this degrades to a plain fresh claim by the assignee:
   *   an expired holder has NO privileged reassign right).
   * - `already_claimed` — a DIFFERENT owner holds a live lease; the ledger is
   *   untouched and `by` names that holder.
   *
   * Lease semantics carry over: the reassignment honours `msg.lease_ttl` (the new
   * holder's lease starts `now`), and a `heartbeat` on `msg` is irrelevant here.
   *
   * @throws InvalidMessageError if `msg` is not `type:"claim"`, fails schema
   *   validation, or has an empty target.
   * @throws InvalidChannelNameError / UnknownChannelError as for {@link claim}.
   */
  reassignClaim(
    channel: string,
    msg: MessageInput,
    assignee: ClaimAssignee,
  ): Promise<ClaimResult>;

  /**
   * Mark a LIVE claim DONE, freeing the target (CAU-18, the ADR-C5 explicit
   * done-state transition). Only the current holder, matched on the anchored
   * `owner` (ADR-C7), may finish a claim.
   *
   * `msg` is a `claim`-typed message carrying the holder's anchored identity and
   * the `target`. On success a `status:"resolved"` `claim` message is appended in
   * the same atomic step (a VISIBLE record of completion — unlike a lapse, which
   * is silent/lazy) and the ledger entry is DELETED, so a later {@link claim} on
   * the target starts a fresh lease and returns `granted`.
   *
   * Outcomes:
   * - `granted` — the caller held the live lease; the resolved message is
   *   appended and the target is freed.
   * - `already_claimed` — a DIFFERENT owner holds a live lease; a NO-OP (no
   *   message, head unchanged), `by` names that holder. You cannot close someone
   *   else's claim.
   * - `not_held` — the target is unheld / never-claimed / already lapsed; a NO-OP
   *   with no message (an expired holder closing its own lapsed claim posts
   *   nothing).
   *
   * @throws InvalidMessageError if `msg` is not `type:"claim"`, fails schema
   *   validation, or has an empty target.
   * @throws InvalidChannelNameError / UnknownChannelError as for {@link claim}.
   */
  markClaimDone(channel: string, msg: MessageInput): Promise<ClaimResult>;

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

  /**
   * Store an opaque blob in a channel's ephemeral evidence store (ADR-C14),
   * content-addressed by SHA-256.
   *
   * The store is per-channel and in-memory: blobs live exactly as long as the
   * channel / process does (no durability, no GC, no explicit delete). The bytes
   * are OPAQUE and binary-safe — they are never validated, parsed, or rendered;
   * they are the same shared-log leak surface as a message body, under the same
   * "never post secrets" boundary (ADR-C12).
   *
   * Behaviour:
   * - Verifies `sha256(bytes)` equals the supplied `sha256` (lowercase hex);
   *   a mismatch throws {@link ArtifactIntegrityError}.
   * - Dedup + idempotent: storing bytes already present for this channel is a
   *   no-op that does NOT re-charge the byte budgets; the result's
   *   `deduplicated` is `true`.
   * - Enforces the three cooperative caps ({@link MAX_ARTIFACT_BYTES},
   *   {@link MAX_CHANNEL_ARTIFACT_BYTES}, {@link MAX_TOTAL_ARTIFACT_BYTES}),
   *   throwing {@link ArtifactTooLargeError} at the first boundary exceeded.
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws UnknownChannelError if no such channel exists.
   * @throws ArtifactIntegrityError if `sha256(bytes)` ≠ `sha256`.
   * @throws ArtifactTooLargeError if any cap would be exceeded.
   */
  putArtifact(
    channel: string,
    sha256: string,
    bytes: Uint8Array,
  ): Promise<PutArtifactResult>;

  /**
   * Fetch an opaque blob from a channel's ephemeral evidence store (ADR-C14).
   * Returns the stored bytes, or `undefined` when the channel exists but holds
   * no blob at that address (the HTTP edge maps `undefined → 404`).
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws UnknownChannelError if no such channel exists.
   */
  getArtifact(channel: string, sha256: string): Promise<Uint8Array | undefined>;
}
