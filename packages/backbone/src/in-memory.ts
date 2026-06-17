/**
 * `InMemoryBackbone` — the reference {@link Backbone} implementation (CAU-4).
 *
 * Pure in-process state: an event log plus two projections (a mutable channel
 * descriptor and a claim ledger) per channel. It is the substrate the unit and
 * integration tests run against, and the executable specification of the
 * contract's semantics. Seatbelts (ADR-C8 — per-agent rate limit + loop/dup
 * detection) are enforced here via a pure synchronous {@link Seatbelt}. NO HTTP,
 * NO durability, NO identity anchoring, NO lease enforcement — those are
 * CAU-5/18.
 *
 * The whole-ballgame property is claim atomicity: `claim()` performs all
 * validation and all `await`s BEFORE entering a critical section, then reads and
 * writes the ledger with no `await` in between, so the check-then-append is
 * effectively a compare-and-set. When durability lands (SQLite) the same
 * read-then-write MUST become a single transaction / unique-constraint upsert —
 * never a read-then-write spanning an `await`. See `docs/BACKBONE_CONTRACT.md`.
 */
import {
  containsControlChars,
  containsControlCharsExceptWhitespace,
  INJECTED_DELTA_CAP_CHARS,
  MalformedMessageError,
  type CaucusMessage,
  MAX_FIELD_CHARS,
  type MessageInput,
  normalizeTarget,
  SCHEMA_VERSION,
  validate,
  validateIdentityField,
} from "@caucus/schema";

import { createHash } from "node:crypto";

import {
  DEFAULT_RENDER_BUDGET_CHARS,
  MAX_ARTIFACT_BYTES,
  MAX_CHANNEL_ARTIFACT_BYTES,
  MAX_TOTAL_ARTIFACT_BYTES,
} from "./contract.js";
import type {
  AppendedMessage,
  AppendResult,
  Backbone,
  ChannelDescriptor,
  ClaimAssignee,
  ClaimResult,
  CreateChannelOptions,
  Cursor,
  PutArtifactResult,
  ReadResult,
  Verbosity,
} from "./contract.js";
import {
  ArtifactIntegrityError,
  ArtifactTooLargeError,
  ChannelExistsError,
  ChannelFullError,
  ChannelLimitError,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  UnknownChannelError,
} from "./errors.js";
import { dupKeyFor, Seatbelt, type SeatbeltOptions } from "./seatbelt.js";

/** Maximum number of characters allowed in a message `body` at the boundary. */
export const MAX_BODY_CHARS = 16_000;

/** Default backbone-wide channel-count cap (CAU-74). */
export const DEFAULT_MAX_CHANNELS = 1_000;

/** Default per-channel message (log-length) cap (CAU-74). */
export const DEFAULT_MAX_MESSAGES_PER_CHANNEL = 10_000;

/** Default `readSince` max page size (CAU-83). */
export const DEFAULT_MAX_READ_LIMIT = 500;

/**
 * Constructor options for {@link InMemoryBackbone}: every seatbelt tunable
 * (rate caps, create throttle, eviction knobs, clock — see
 * {@link SeatbeltOptions}) plus the CAU-74 COUNT caps the backbone enforces
 * itself. A plain widening of `SeatbeltOptions`, so every existing
 * `new InMemoryBackbone(seatbeltOpts)` call site stays source-compatible.
 */
export type InMemoryBackboneOptions = SeatbeltOptions & {
  /** Backbone-wide channel-count cap. Default {@link DEFAULT_MAX_CHANNELS}. */
  readonly maxChannels?: number;
  /**
   * Per-channel message cap (log length). Default
   * {@link DEFAULT_MAX_MESSAGES_PER_CHANNEL}.
   */
  readonly maxMessagesPerChannel?: number;
  /**
   * `readSince` max page size (CAU-83): every read returns at most this many
   * messages, regardless of the requested `limit` (an over-cap or omitted
   * `limit` is SILENTLY clamped, never an error — cursor catch-up converges by
   * reading again from the returned cursor). Default
   * {@link DEFAULT_MAX_READ_LIMIT}. Unlike the CAU-74 count caps, this value is
   * FLOORED at construction (CAU-90): a non-positive or NaN cap would make every
   * page empty — a silent "caught up" footgun — so it falls back to the default.
   */
  readonly maxReadLimit?: number;
};

/**
 * Maximum number of characters allowed in each short free-text identifier
 * field stored by the backbone: a claim `target` (also the unbounded ledger
 * key), a channel `purpose`, and every `to[]` entry. These are short
 * identifiers / descriptions, not payloads, so they get a much tighter cap than
 * `body`.
 *
 * Re-exported from `@caucus/schema` so there is a SINGLE source of truth: the
 * shared `validate` caps `agent_id`/`owner`/`artifact` to the same constant
 * (CAU-90), and the backbone caps the descriptor/ledger fields it owns
 * (`target`/`purpose`/`to[]` entries) that don't pass through `validate`.
 */
export { MAX_FIELD_CHARS };

/**
 * Recursively `Object.freeze` a value and every nested object/array it owns, so
 * a stored log message (and every reference handed back to a caller) is deeply
 * immutable. This is the in-memory equivalent of a durable store handing back a
 * fresh row: callers must never be able to mutate the log by holding a returned
 * message. Cheaper than `structuredClone` since the stored object IS the
 * returned one. Returns its argument for convenient inline use.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
  }
  return value;
}

/** Channel slug grammar (lowercase alnum, internal hyphens, 1–64 chars). */
const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A lowercase-hex SHA-256 content address: exactly 64 hex digits (ADR-C14). */
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Build the logical, host-agnostic artifact URI (ADR-C14). It carries NO host —
 * the MCP client resolves it against its OWN validated `CAUCUS_URL` at fetch
 * time, so the backbone never embeds a dialable host (no SSRF surface).
 */
function artifactUri(channel: string, sha256: string): string {
  return `caucus://artifact/${channel}/${sha256}`;
}

/**
 * A ledger entry recording who currently holds a given normalized target
 * (CAU-4 + the CAU-18 lifecycle fields).
 *
 * `claimed_at_ms` / `lease_ttl_s` are **backbone-internal projection state**, not
 * on the wire (ADR-C5 amendment, MESSAGE_SCHEMA): they back lazy wall-clock lease
 * expiry. `claimed_at_ms` is `#seatbelt.now()` (ms since epoch) at the moment the
 * lease was last (re)granted — i.e. the original grant, a heartbeat renew, or a
 * reassignment. `lease_ttl_s` mirrors the granting claim's `lease_ttl` (seconds);
 * `undefined` ⇒ the claim **never expires** (backward-compatible with pre-CAU-18
 * behaviour, where every claim held indefinitely).
 */
interface ClaimRecord {
  readonly agent_id: string;
  readonly owner: string;
  readonly ts: string;
  readonly msg_id: string;
  /** Wall-clock ms (from `#seatbelt.now()`) the lease was last (re)granted. */
  readonly claimed_at_ms: number;
  /** Lease length in seconds; `undefined` ⇒ never expires. */
  readonly lease_ttl_s?: number;
}

/** Mutable per-channel state: the descriptor, the log, and the claim ledger. */
interface ChannelState {
  descriptor: {
    channel: string;
    kind: "ephemeral";
    purpose: string;
    verbosity: Verbosity;
    renderBudgetChars: number;
    created_by: string;
    created_ts: string;
    head: Cursor;
  };
  readonly log: AppendedMessage[];
  readonly claimLedger: Map<string, ClaimRecord>;
  /**
   * The ephemeral evidence store (ADR-C14): a content-addressed `sha256 → bytes`
   * map. Lives exactly as long as this `ChannelState` (channel = process exit) —
   * no durability, no GC, no explicit delete. Bytes are opaque and binary-safe;
   * they are never validated, parsed, or rendered.
   */
  readonly artifacts: Map<string, Uint8Array>;
  /**
   * Running total of the DISTINCT blob bytes stored against this channel
   * (CAU-74-style accounting): the sum of `artifacts`' value lengths. Maintained
   * incrementally on each non-dedup store so the per-channel cap can be checked
   * in O(1).
   */
  artifactBytes: number;
}

export class InMemoryBackbone implements Backbone {
  /** All channels, keyed by name. */
  readonly #channels = new Map<string, ChannelState>();

  /**
   * The seatbelt (ADR-C8): per-agent rate limit + loop/dup detection. Pure and
   * synchronous, so it can run inside the claim critical section without any
   * `await`. Built from the constructor options; defaults never throttle normal
   * demo traffic.
   */
  readonly #seatbelt: Seatbelt;

  /** Backbone-wide channel-count cap (CAU-74). */
  readonly #maxChannels: number;

  /** Per-channel message (log-length) cap (CAU-74). */
  readonly #maxMessagesPerChannel: number;

  /** `readSince` max page size (CAU-83). */
  readonly #maxReadLimit: number;

  /**
   * Running total of the DISTINCT artifact bytes stored across ALL channels
   * (ADR-C14). Maintained incrementally alongside each channel's
   * `artifactBytes` so the backbone-wide cap is an O(1) check on every PUT.
   */
  #totalArtifactBytes = 0;

  /**
   * @param opts seatbelt tunables (caps / window / clock) plus the CAU-74
   * count caps. Defaults are production-safe: generous rate caps, bounded
   * channel/log counts, and `Date.now` as the clock. Tests inject low caps
   * and/or a deterministic clock.
   */
  constructor(opts: InMemoryBackboneOptions = {}) {
    this.#seatbelt = new Seatbelt(opts);
    this.#maxChannels = opts.maxChannels ?? DEFAULT_MAX_CHANNELS;
    this.#maxMessagesPerChannel =
      opts.maxMessagesPerChannel ?? DEFAULT_MAX_MESSAGES_PER_CHANNEL;
    // Floor `maxReadLimit` at construction (CAU-90). A value ≤ 0 (or NaN, e.g.
    // from a fat-fingered env knob) would clamp EVERY `readSince` page to length
    // 0 — `readSince` reads as "caught up" and the hook silently delivers
    // nothing, an integrity footgun with no error. We floor to the DEFAULT
    // rather than to 1: a non-positive/NaN cap is a misconfiguration, not a
    // request for single-message paging, so the safe recovery is the documented
    // default page size — keeping catch-up fast — not a pathologically slow
    // one-at-a-time stream. Floor FIRST, then check `> 0`: a fractional cap in
    // `(0, 1)` (e.g. 0.5) passes a `> 0` test but `Math.floor`s to 0, which would
    // reintroduce the empty-page footgun — so the truncation must happen before
    // the positivity check. `Number.isFinite` rejects NaN/±Infinity (NaN must
    // not pass through).
    const requestedReadLimit = opts.maxReadLimit ?? DEFAULT_MAX_READ_LIMIT;
    const flooredReadLimit = Math.floor(requestedReadLimit);
    this.#maxReadLimit =
      Number.isFinite(flooredReadLimit) && flooredReadLimit > 0
        ? flooredReadLimit
        : DEFAULT_MAX_READ_LIMIT;
  }

  /**
   * Monotonic counter backing the `ts` stamp. Bare `Date.toISOString()` ties
   * under a tight loop (same millisecond), which would break the
   * strictly-increasing `ts` guarantee; we append a zero-padded sequence so each
   * stamp is unique and ordered.
   */
  #seq = 0;

  /**
   * Produce a server-monotonic timestamp. Strictly increasing across calls,
   * independent of clock resolution.
   *
   * The returned string is an opaque monotonic stamp, NOT a parseable
   * ISO-8601 instant: it has a `#<seq>` suffix, so `Date.parse(ts)` is `NaN`.
   * Do not parse it as a date. Lexical (string) sort agrees with append order
   * only because the sequence is zero-padded to a fixed 12 digits — that pad
   * width is the lexical-sort bound (it overflows past 1e12 appends per
   * process). Even so, the authoritative ordering is the cursor / log index,
   * not a `ts` string comparison; `ts` ordering is a convenience.
   */
  #stamp(): string {
    const seq = (++this.#seq).toString().padStart(12, "0");
    return `${new Date().toISOString()}#${seq}`;
  }

  /** Validate a channel name at the boundary; throw on a bad slug. */
  #assertChannelName(channel: string): void {
    if (typeof channel !== "string" || !CHANNEL_NAME_RE.test(channel)) {
      throw new InvalidChannelNameError(channel);
    }
  }

  /** Resolve a channel after name validation; throw if it does not exist. */
  #requireChannel(channel: string): ChannelState {
    this.#assertChannelName(channel);
    const state = this.#channels.get(channel);
    if (state === undefined) {
      throw new UnknownChannelError(channel);
    }
    return state;
  }

  /** Snapshot a channel's descriptor (live `head`) as an immutable copy. */
  #snapshot(state: ChannelState): ChannelDescriptor {
    return { ...state.descriptor };
  }

  /**
   * Run schema validation and the body-size cap on an authored message,
   * wrapping any schema `MalformedMessageError` into {@link InvalidMessageError}
   * so schema errors never leak. Returns the version-stamped message.
   */
  #validateMessage(msg: MessageInput): CaucusMessage {
    const stamped = { ...msg, v: SCHEMA_VERSION } as CaucusMessage;
    try {
      validate(stamped);
    } catch (err) {
      if (err instanceof MalformedMessageError) {
        throw new InvalidMessageError(err.issues);
      }
      throw err;
    }
    if (typeof msg.body === "string" && msg.body.length > MAX_BODY_CHARS) {
      throw new InvalidMessageError([
        `body exceeds ${MAX_BODY_CHARS} characters`,
      ]);
    }
    // Short free-text identifier fields get a tight cap so an oversized
    // `target` (the unbounded ledger key) or `to[]` entry can't be stored.
    if (
      msg.type === "claim" &&
      typeof msg.target === "string" &&
      msg.target.length > MAX_FIELD_CHARS
    ) {
      throw new InvalidMessageError([
        `target exceeds ${MAX_FIELD_CHARS} characters`,
      ]);
    }
    if (Array.isArray(msg.to)) {
      for (const recipient of msg.to) {
        if (typeof recipient === "string" && recipient.length > MAX_FIELD_CHARS) {
          throw new InvalidMessageError([
            `to[] entry exceeds ${MAX_FIELD_CHARS} characters`,
          ]);
        }
      }
    }
    return stamped;
  }

  /**
   * Synchronously append an already-validated, version-stamped message to a
   * channel log, stamping `ts` and advancing the head. Returns the appended
   * message. NO `await` inside — used directly within the claim critical
   * section.
   */
  #appendSync(state: ChannelState, message: CaucusMessage): AppendedMessage {
    // Deep-freeze BEFORE push so the single stored object — which is also the
    // exact reference returned to callers and re-handed by `readSince` — is
    // immutable. This upholds the contract's log-immutability guarantee
    // (see AppendedMessage / ReadResult TSDoc and docs/BACKBONE_CONTRACT.md):
    // a caller holding a returned message cannot mutate the stored log.
    const appended = deepFreeze({
      ...message,
      ts: this.#stamp(),
    }) as AppendedMessage;
    state.log.push(appended);
    state.descriptor.head = state.log.length;
    return appended;
  }

  async createChannel(
    opts: CreateChannelOptions,
  ): Promise<ChannelDescriptor> {
    this.#assertChannelName(opts.channel);
    if (this.#channels.has(opts.channel)) {
      throw new ChannelExistsError(opts.channel);
    }
    // Descriptor fields don't go through `validate`, so the contract's
    // `string | undefined` typing and the write-time control-character
    // rejection (CAU-71) are both enforced here. A present-but-non-string
    // value (reachable via an untyped HTTP body) is rejected OUTRIGHT — if it
    // were stored, the read-side sanitizers would throw on it and poison
    // every list/describe until restart. `undefined` (absent) stays allowed.
    // Error strings never echo the offending payload (ADR-C12).
    if (opts.purpose !== undefined) {
      if (typeof opts.purpose !== "string") {
        throw new InvalidMessageError(["purpose must be a string"]);
      }
      // `purpose` is a short free-text description stored on the descriptor;
      // cap it like the other identifier fields so a 2MB purpose can't be
      // stored.
      if (opts.purpose.length > MAX_FIELD_CHARS) {
        throw new InvalidMessageError([
          `purpose exceeds ${MAX_FIELD_CHARS} characters`,
        ]);
      }
      // `purpose` is multi-line free text (`\t`/`\n` allowed, like a body).
      if (containsControlCharsExceptWhitespace(opts.purpose)) {
        throw new InvalidMessageError([
          "purpose must not contain control characters (tab and newline are allowed)",
        ]);
      }
    }
    if (opts.created_by !== undefined) {
      if (typeof opts.created_by !== "string") {
        throw new InvalidMessageError(["created_by must be a string"]);
      }
      // `created_by` is a single-token owner label (no whitespace controls).
      if (containsControlChars(opts.created_by)) {
        throw new InvalidMessageError([
          "created_by must not contain control characters",
        ]);
      }
    }
    // CAU-94: the per-message render budget is an integer clamped to
    // [1, INJECTED_DELTA_CAP_CHARS]. A present-but-invalid value (reachable via
    // an untyped HTTP body) is rejected OUTRIGHT rather than coerced, so the
    // descriptor always carries a sane budget for the hook to thread. Absent
    // ⇒ the calm default (set below, mirroring `verbosity`).
    if (opts.renderBudgetChars !== undefined) {
      if (
        typeof opts.renderBudgetChars !== "number" ||
        !Number.isInteger(opts.renderBudgetChars) ||
        opts.renderBudgetChars < 1 ||
        opts.renderBudgetChars > INJECTED_DELTA_CAP_CHARS
      ) {
        throw new InvalidMessageError([
          `renderBudgetChars must be an integer in [1, ${INJECTED_DELTA_CAP_CHARS}]`,
        ]);
      }
    }
    // CAU-74 resource gates, deliberately LAST — after the slug check, the
    // ChannelExistsError check (a warm demo rerun must never touch the create
    // budget), and the field validation above, so a rejected create consumes
    // no budget. Count cap first (capacity), then the per-creator create
    // throttle (pacing): `admitChannelCreate` is check-AND-record in one call,
    // which is safe ONLY because the `Map.set` below is infallible.
    if (this.#channels.size >= this.#maxChannels) {
      throw new ChannelLimitError(this.#maxChannels);
    }
    // The throttle keys on the creator/owner identity: the HTTP server anchors
    // `created_by: identity.owner` before calling us (CAU-13), so over the
    // wire this is a per-owner budget. In-process callers that omit
    // `created_by` all share the "" budget — acceptable for trusted
    // in-process use (tests, demos).
    this.#seatbelt.admitChannelCreate(
      opts.created_by ?? "",
      this.#seatbelt.now(),
    );
    const state: ChannelState = {
      descriptor: {
        channel: opts.channel,
        kind: "ephemeral",
        purpose: opts.purpose,
        verbosity: opts.verbosity ?? "quiet",
        renderBudgetChars: opts.renderBudgetChars ?? DEFAULT_RENDER_BUDGET_CHARS,
        created_by: opts.created_by,
        created_ts: this.#stamp(),
        head: 0,
      },
      log: [],
      claimLedger: new Map(),
      artifacts: new Map(),
      artifactBytes: 0,
    };
    this.#channels.set(opts.channel, state);
    return this.#snapshot(state);
  }

  async describeChannel(channel: string): Promise<ChannelDescriptor> {
    return this.#snapshot(this.#requireChannel(channel));
  }

  async listChannels(): Promise<readonly ChannelDescriptor[]> {
    return [...this.#channels.values()].map((state) => this.#snapshot(state));
  }

  async append(channel: string, msg: MessageInput): Promise<AppendResult> {
    const state = this.#requireChannel(channel);
    if (msg.type === "claim") {
      throw new InvalidMessageError([
        "use claim() for claim messages",
      ]);
    }
    const validated = this.#validateMessage(msg);
    // Per-channel message cap (CAU-74), checked BEFORE the seatbelt admits:
    // a doomed post on a full channel must not burn rate budget or become the
    // agent's dup baseline.
    if (state.log.length >= this.#maxMessagesPerChannel) {
      throw new ChannelFullError(channel, this.#maxMessagesPerChannel);
    }
    // Seatbelt (ADR-C8): rate + loop/dup gate. `admit` throws (rate_limited /
    // duplicate_post) BEFORE recording anything, so a rejected post is never
    // appended and consumes no budget. Synchronous — no `await` is introduced.
    this.#seatbelt.admit(
      channel,
      msg.agent_id,
      dupKeyFor(msg.type, msg.body),
      this.#seatbelt.now(),
    );
    const message = this.#appendSync(state, validated);
    return { message, cursor: state.descriptor.head };
  }

  async readSince(
    channel: string,
    cursor: Cursor,
    limit?: number,
  ): Promise<ReadResult> {
    const state = this.#requireChannel(channel);
    const head = state.descriptor.head;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > head) {
      throw new InvalidCursorError(
        `cursor must be an integer in [0, ${head}]`,
        cursor,
      );
    }
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
      throw new InvalidCursorError(
        "limit must be a positive integer",
        limit,
      );
    }
    // Max page size (CAU-83): an omitted or over-cap `limit` is SILENTLY
    // clamped to `maxReadLimit` — never an error. A whole-log read against a
    // full channel would otherwise serialize hundreds of MB in one synchronous
    // call. Cursor semantics are unchanged: the returned cursor advances by
    // exactly `messages.length`, so a caller catches up by reading again from
    // it until a page comes back empty.
    const effective = Math.min(limit ?? this.#maxReadLimit, this.#maxReadLimit);
    const end = Math.min(head, cursor + effective);
    const messages = state.log.slice(cursor, end);
    return { messages, cursor: cursor + messages.length };
  }

  /**
   * Decide whether a held lease has lapsed at instant `nowMs` (CAU-18, lazy
   * wall-clock expiry). Pure and synchronous so it runs inside the critical
   * section without a yield.
   *
   * A record with no `lease_ttl_s` NEVER expires (backward-compatible with the
   * pre-CAU-18 hold-forever behaviour). Otherwise the lease lapses once
   * `nowMs >= claimed_at_ms + ttl*1000` (the `>=` makes the deadline itself
   * re-claimable — a claim AT the boundary frees the target). **Clock-backwards
   * is safe:** if `nowMs < claimed_at_ms` (the injected/system clock moved
   * back), the comparison is false, so the lease is treated as still held —
   * never spuriously expired.
   */
  #isExpired(record: ClaimRecord, nowMs: number): boolean {
    if (record.lease_ttl_s === undefined) return false;
    return nowMs >= record.claimed_at_ms + record.lease_ttl_s * 1000;
  }

  /**
   * The single synchronous compare-and-set shared by every claim-ledger
   * transition — `claim()` (fresh grant / lazy-expiry overwrite / heartbeat
   * renew), `reassignClaim()`, and `markClaimDone()` (CAU-18). It holds the ONE
   * marked critical region for the whole package, so the no-`await` guard
   * (`claim-critical-section.test.ts`) has exactly one region to police.
   *
   * Inputs are all resolved BEFORE the call (channel lookup, schema validation,
   * the ONE `now` read, the seatbelt rate check). `nowMs` is read once by the
   * caller and threaded in, so the read→mutate→write below sees a single instant
   * and introduces no clock call (and thus no yield) of its own.
   *
   * `mode` selects the transition:
   * - `"claim"`: first-write-wins. An absent OR lapsed lease is OVERWRITTEN with
   *   a fresh grant (the expired entry is replaced, never left dangling); a live
   *   lease held by the same `owner` with `heartbeat` renews in place; any other
   *   live lease loses (`already_claimed`). The seatbelt is charged only on a
   *   write.
   * - `"reassign"`: privileged. Requires a LIVE lease whose holder `owner`
   *   matches the caller (`authorizerOwner`); on match the appended `claim`
   *   message (authored as the new holder) replaces the ledger record. A missing,
   *   lapsed, or different-owner lease loses (`already_claimed`) and the ledger is
   *   untouched — an expired claim is unheld, so its former holder has no special
   *   right (it falls through to a fresh claim by whoever claims next).
   * - `"done"`: privileged. Requires a LIVE lease whose holder `owner` matches
   *   the caller; on match a `status:"resolved"` message is appended and the
   *   ledger entry is DELETED, freeing the target. A missing/lapsed/foreign lease
   *   is a silent no-op (no message, head unchanged).
   */
  #commitClaimTransition(
    state: ChannelState,
    channel: string,
    mode: "claim" | "reassign" | "done",
    message: CaucusMessage,
    key: string,
    rateAgentId: string,
    nowMs: number,
    authorizerOwner: string,
    leaseTtlSeconds: number | undefined,
    ledgerHolder?: ClaimAssignee,
  ): ClaimResult {
    // ---- CLAIM-CRITICAL-SECTION-BEGIN (do not rename: the marker is the
    // ---- anchor for the automated guard in claim-critical-section.test.ts,
    // ---- which fails the build if an `await` ever appears inside) ----
    // ---- BEGIN critical section: NO `await` between the ledger read and the
    // ---- ledger write. This is the first-write-wins compare-and-set, now also
    // ---- covering lazy expiry, heartbeat-renew, reassign, and done. When
    // ---- durability lands this MUST become a single transaction / unique
    // ---- constraint, never a read-then-write across an `await`.
    const existing = state.claimLedger.get(key);
    // A lapsed lease is treated as if absent: it frees the target. Computed
    // against the single `nowMs` the caller read — no clock call here.
    const live =
      existing !== undefined && !this.#isExpired(existing, nowMs)
        ? existing
        : undefined;

    if (mode === "done") {
      // Done needs a LIVE lease whose holder owner matches the caller (ADR-C7:
      // match the anchored human, not the session agent_id, so a human may close
      // a claim across their own sessions). Anything else is a NO-OP — no
      // message, head unchanged, ledger untouched:
      //  - a different owner holds it (you can't close someone else's claim) →
      //    `already_claimed` naming the holder;
      //  - the target is unheld / lapsed / never-claimed → `not_held`.
      // Done by an EXPIRED holder is therefore a no-op with no spurious message
      // (its lease already lapsed; there is nothing live to resolve).
      if (live === undefined) {
        return { outcome: "not_held" };
      }
      if (live.owner !== authorizerOwner) {
        return {
          outcome: "already_claimed",
          by: {
            agent_id: live.agent_id,
            owner: live.owner,
            ts: live.ts,
            msg_id: live.msg_id,
          },
        };
      }
      // else: fall through to the write path (append resolved + delete entry).
    } else if (mode === "reassign") {
      // Reassign is privileged ONLY against a LIVE lease the caller holds: the
      // holder hands the live target to `assignee`. If the target is held by a
      // DIFFERENT owner the reassign loses like an ordinary claim conflict
      // (`already_claimed`) and the ledger is untouched. If the target is UNHELD
      // or LAPSED, reassign is NOT privileged — an expired holder has no special
      // right — so it falls through to a plain fresh grant to the assignee
      // (whoever claims an unheld target wins it), the same as `mode:"claim"`
      // would. The write path below records the assignee either way.
      if (live !== undefined && live.owner !== authorizerOwner) {
        return {
          outcome: "already_claimed",
          by: {
            agent_id: live.agent_id,
            owner: live.owner,
            ts: live.ts,
            msg_id: live.msg_id,
          },
        };
      }
      // else (caller holds the live lease, OR the target is unheld/lapsed):
      // fall through to the write path — (over)write the ledger to the assignee.
    } else if (live !== undefined) {
      // mode === "claim" with a LIVE lease. A heartbeat from the SAME owner
      // renews in place; anything else loses first-write-wins.
      const isHeartbeatRenew =
        message.type === "claim" &&
        message.heartbeat === true &&
        live.owner === authorizerOwner;
      if (!isHeartbeatRenew) {
        // Loser: consumes NO rate budget (we never call recordRate). This path
        // stays available even when the channel is FULL (CAU-74): answering an
        // already-claimed target needs no append.
        return {
          outcome: "already_claimed",
          by: {
            agent_id: live.agent_id,
            owner: live.owner,
            ts: live.ts,
            msg_id: live.msg_id,
          },
        };
      }
    }

    // ---- WRITE PATH (granted claim / renew / reassign / done) ----
    // Per-channel message cap (CAU-74): only the WOULD-APPEND path is blocked on
    // a full channel, before anything is written. Synchronous — the no-await CAS
    // invariant between the ledger read above and the writes below holds. The
    // ledger needs NO separate cap and is never evicted beyond `done` removing
    // its own entry: every entry is created only alongside an append, so
    // `claimLedger.size <= log.length <= maxMessagesPerChannel`.
    if (state.log.length >= this.#maxMessagesPerChannel) {
      throw new ChannelFullError(channel, this.#maxMessagesPerChannel);
    }
    const appended = this.#appendSync(state, message);
    if (mode === "done") {
      // Done frees the target by removing the ledger entry; the resolved message
      // is the visible record of the transition (expiry, by contrast, posts
      // nothing — it is lazy and silent).
      state.claimLedger.delete(key);
    } else {
      // claim / reassign: (over)write the ledger to point at the new holder. For
      // an expired entry this OVERWRITES the dangling record rather than leaving
      // it; for a heartbeat renew it resets `claimed_at_ms` to `nowMs`. The
      // ledger holder is the appended message's author for a plain claim/renew;
      // for a reassign it is the `ledgerHolder` (the assignee) — the appended
      // message stays authored by the authenticated caller (the handing-off
      // holder), so attribution is never forged, but the LEDGER points at the new
      // holder (the assignee is poster-asserted data the authenticated holder
      // vouches for, like `to[]` — never identity-anchored).
      const holder = ledgerHolder ?? {
        agent_id: appended.agent_id,
        owner: appended.owner,
      };
      state.claimLedger.set(key, {
        agent_id: holder.agent_id,
        owner: holder.owner,
        ts: appended.ts,
        msg_id: appended.msg_id,
        claimed_at_ms: nowMs,
        lease_ttl_s: leaseTtlSeconds,
      });
    }
    // Record the post against the rate window now that it's committed.
    this.#seatbelt.recordRate(channel, rateAgentId, nowMs);
    // ---- END critical section ----
    // ---- CLAIM-CRITICAL-SECTION-END ----

    return { outcome: "granted", message: appended, cursor: state.descriptor.head };
  }

  async claim(channel: string, msg: MessageInput): Promise<ClaimResult> {
    // ---- All validation and lookups happen BEFORE the critical section. ----
    const state = this.#requireChannel(channel);
    if (msg.type !== "claim") {
      throw new InvalidMessageError(['claim() requires type "claim"']);
    }
    const validated = this.#validateMessage(msg);
    // `validate` already required a non-empty target on claim; derive the key.
    let key: string;
    try {
      key = normalizeTarget(msg.target);
    } catch (err) {
      if (err instanceof MalformedMessageError) {
        throw new InvalidMessageError(err.issues);
      }
      throw err;
    }

    // Seatbelt (ADR-C8) — the rate-limit split for claims. CHECK here, BEFORE
    // the critical section, but DO NOT record yet: a claim that loses the
    // first-write-wins race (`already_claimed`) is a no-op write and must NOT be
    // charged budget — otherwise a swarm of agents racing the same hot target
    // would all be rate-limited for losing a race they can't avoid. We capture
    // `now` ONCE so the rate check, the lazy-expiry comparison, and the in-branch
    // record all see the SAME instant. Claims are NOT dup-checked: the ledger's
    // `already_claimed` IS the dedup answer, so a duplicate_post throw would be
    // redundant and would mask the real (claim) outcome. Synchronous — no
    // `await`, so the critical section below stays a true compare-and-set.
    const now = this.#seatbelt.now();
    this.#seatbelt.checkRate(channel, msg.agent_id, now);

    return this.#commitClaimTransition(
      state,
      channel,
      "claim",
      validated,
      key,
      msg.agent_id,
      now,
      msg.owner,
      msg.lease_ttl,
    );
  }

  async reassignClaim(
    channel: string,
    msg: MessageInput,
    assignee: ClaimAssignee,
  ): Promise<ClaimResult> {
    // ---- All validation and lookups happen BEFORE the critical section. ----
    const state = this.#requireChannel(channel);
    if (msg.type !== "claim") {
      throw new InvalidMessageError(['reassignClaim() requires type "claim"']);
    }
    // The appended message stays authored by the AUTHENTICATED CALLER (the
    // current holder announcing the handoff) — `stampIdentity` / the HTTP edge
    // anchored `msg.agent_id`/`msg.owner`, so attribution is never forged. The
    // `assignee` is the NEW LEDGER HOLDER: poster-asserted data the authenticated
    // holder vouches for (like a `to[]` recipient — never identity-anchored). So
    // the visible message says "<holder> reassigned <target>" while the ledger
    // now points at the assignee. `msg.owner` is the AUTHORIZER matched against
    // the current holder (ADR-C7). Validate the message as-authored.
    const validated = this.#validateMessage(msg);
    // The `assignee` is poster-asserted (the holder vouches for it, like `to[]`),
    // so it bypasses `#validateMessage` — but it IS written raw into the ledger
    // as the stored holder, so it MUST face the SAME identity-field constraints
    // as `msg.agent_id`/`msg.owner` (non-empty, no control chars, ≤ MAX_FIELD_CHARS)
    // to avoid stored-tainted-identity / memory-amplification (CAU-18 security).
    // Uses the shared validator so the constraints can never drift; NON-echoing
    // (ADR-C12) — the error never reflects the offending assignee content.
    const assigneeIssues = [
      ...validateIdentityField("assignee.agent_id", assignee?.agent_id),
      ...validateIdentityField("assignee.owner", assignee?.owner),
    ];
    if (assigneeIssues.length > 0) {
      throw new InvalidMessageError(assigneeIssues);
    }
    let key: string;
    try {
      key = normalizeTarget(msg.target);
    } catch (err) {
      if (err instanceof MalformedMessageError) {
        throw new InvalidMessageError(err.issues);
      }
      throw err;
    }
    // Rate-check against the AUTHORIZING caller (the holder doing the reassign),
    // not the assignee — the assignee did not author this call.
    const now = this.#seatbelt.now();
    this.#seatbelt.checkRate(channel, msg.agent_id, now);

    return this.#commitClaimTransition(
      state,
      channel,
      "reassign",
      validated,
      key,
      msg.agent_id,
      now,
      msg.owner,
      msg.lease_ttl,
      assignee,
    );
  }

  async markClaimDone(
    channel: string,
    msg: MessageInput,
  ): Promise<ClaimResult> {
    // ---- All validation and lookups happen BEFORE the critical section. ----
    const state = this.#requireChannel(channel);
    if (msg.type !== "claim") {
      throw new InvalidMessageError(['markClaimDone() requires type "claim"']);
    }
    // The done transition posts a `status:"resolved"` message (an existing-typed
    // message — no new wire type/status value, ADR-free). We carry it as a
    // `claim`-typed message (so it routes through this ledger path and is
    // schema-valid with the required `target`) stamped with `status:"resolved"`,
    // and the ledger ENTRY is deleted on commit. Derive the resolved message
    // before the critical section.
    // `msg.type === "claim"` was just asserted, so `msg.target` is a string;
    // preserve that narrowing through the spread (no widening `as MessageInput`)
    // so the key can be derived from the SAME resolved message we validate and
    // commit — consistent with `claim`/`reassign`, which key off their validated
    // message's target.
    const resolved = { ...msg, status: "resolved" as const };
    const validated = this.#validateMessage(resolved);
    let key: string;
    try {
      key = normalizeTarget(resolved.target);
    } catch (err) {
      if (err instanceof MalformedMessageError) {
        throw new InvalidMessageError(err.issues);
      }
      throw err;
    }
    const now = this.#seatbelt.now();
    this.#seatbelt.checkRate(channel, msg.agent_id, now);

    return this.#commitClaimTransition(
      state,
      channel,
      "done",
      validated,
      key,
      msg.agent_id,
      now,
      msg.owner,
      undefined,
    );
  }

  async subscribe(channel: string): Promise<Cursor> {
    return this.#requireChannel(channel).descriptor.head;
  }

  async putArtifact(
    channel: string,
    sha256: string,
    bytes: Uint8Array,
  ): Promise<PutArtifactResult> {
    const state = this.#requireChannel(channel);
    // The supplied address must be a syntactically valid SHA-256 hex digest;
    // anything else can never equal `sha256(bytes)`, so reject it as an
    // integrity failure (a malformed `:sha256` path segment over the wire). No
    // content is echoed (ADR-C12).
    if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) {
      throw new ArtifactIntegrityError();
    }
    // Per-blob cap (ADR-C14). The HTTP edge already rejects mid-stream, but the
    // backbone is the single in-process authority and an in-process caller (a
    // test/demo) reaches here directly, so re-check on the assembled buffer.
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      throw new ArtifactTooLargeError("blob", MAX_ARTIFACT_BYTES);
    }
    // Integrity: the bytes MUST hash to the address they're stored under
    // (content-addressing is only meaningful if verified). Compute once.
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== sha256) {
      throw new ArtifactIntegrityError();
    }
    // Dedup + idempotent: identical bytes already stored for this channel are a
    // no-op that does NOT re-charge either byte budget (the blob counts once).
    if (state.artifacts.has(sha256)) {
      return {
        uri: artifactUri(channel, sha256),
        sha256,
        size: bytes.length,
        deduplicated: true,
      };
    }
    // Running-total cap checks BEFORE storing (cheap O(1)): per-channel first,
    // then global. A rejected store mutates nothing — the byte totals only move
    // on the success path below.
    if (state.artifactBytes + bytes.length > MAX_CHANNEL_ARTIFACT_BYTES) {
      throw new ArtifactTooLargeError("channel", MAX_CHANNEL_ARTIFACT_BYTES);
    }
    if (this.#totalArtifactBytes + bytes.length > MAX_TOTAL_ARTIFACT_BYTES) {
      throw new ArtifactTooLargeError("global", MAX_TOTAL_ARTIFACT_BYTES);
    }
    // Copy the bytes so a caller mutating its buffer afterwards can't alter the
    // stored, content-addressed blob (the address would no longer match).
    state.artifacts.set(sha256, Uint8Array.from(bytes));
    state.artifactBytes += bytes.length;
    this.#totalArtifactBytes += bytes.length;
    return {
      uri: artifactUri(channel, sha256),
      sha256,
      size: bytes.length,
      deduplicated: false,
    };
  }

  async getArtifact(
    channel: string,
    sha256: string,
  ): Promise<Uint8Array | undefined> {
    // Unknown CHANNEL throws (UnknownChannelError → 404 at the edge); a known
    // channel with no blob at that address returns undefined (also → 404, but a
    // distinct in-process signal). A malformed address simply never matches, so
    // it is an ordinary miss — no special error.
    const state = this.#requireChannel(channel);
    return state.artifacts.get(sha256);
  }
}
