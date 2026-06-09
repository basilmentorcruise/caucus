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
  MalformedMessageError,
  type CaucusMessage,
  type MessageInput,
  normalizeTarget,
  SCHEMA_VERSION,
  validate,
} from "@caucus/schema";

import type {
  AppendedMessage,
  AppendResult,
  Backbone,
  ChannelDescriptor,
  ClaimResult,
  CreateChannelOptions,
  Cursor,
  ReadResult,
  Verbosity,
} from "./contract.js";
import {
  ChannelExistsError,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  UnknownChannelError,
} from "./errors.js";
import { dupKeyFor, Seatbelt, type SeatbeltOptions } from "./seatbelt.js";

/** Maximum number of characters allowed in a message `body` at the boundary. */
export const MAX_BODY_CHARS = 16_000;

/**
 * Maximum number of characters allowed in each short free-text identifier
 * field stored by the backbone: a claim `target` (also the unbounded ledger
 * key), a channel `purpose`, and every `to[]` entry. These are short
 * identifiers / descriptions, not payloads, so they get a much tighter cap than
 * `body`.
 */
export const MAX_FIELD_CHARS = 1_024;

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

/** A ledger entry recording who won a given normalized target. */
interface ClaimRecord {
  readonly agent_id: string;
  readonly owner: string;
  readonly ts: string;
  readonly msg_id: string;
}

/** Mutable per-channel state: the descriptor, the log, and the claim ledger. */
interface ChannelState {
  descriptor: {
    channel: string;
    kind: "ephemeral";
    purpose: string;
    verbosity: Verbosity;
    created_by: string;
    created_ts: string;
    head: Cursor;
  };
  readonly log: AppendedMessage[];
  readonly claimLedger: Map<string, ClaimRecord>;
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

  /**
   * @param opts seatbelt tunables (cap / window / clock). Defaults are
   * production-safe: a generous per-agent posts/min cap and `Date.now` as the
   * clock. Tests inject a low cap and/or a deterministic clock.
   */
  constructor(opts: SeatbeltOptions = {}) {
    this.#seatbelt = new Seatbelt(opts);
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
    // `purpose` is a short free-text description stored on the descriptor; cap
    // it like the other identifier fields so a 2MB purpose can't be stored.
    if (
      typeof opts.purpose === "string" &&
      opts.purpose.length > MAX_FIELD_CHARS
    ) {
      throw new InvalidMessageError([
        `purpose exceeds ${MAX_FIELD_CHARS} characters`,
      ]);
    }
    // Descriptor fields don't go through `validate`, so the write-time
    // control-character rejection (CAU-71) is enforced here. `purpose` is
    // multi-line free text (`\t`/`\n` allowed, like a message body);
    // `created_by` is a single-token owner label (no whitespace controls).
    // Error strings never echo the offending bytes (ADR-C12).
    if (
      typeof opts.purpose === "string" &&
      containsControlCharsExceptWhitespace(opts.purpose)
    ) {
      throw new InvalidMessageError([
        "purpose must not contain control characters (tab and newline are allowed)",
      ]);
    }
    if (
      typeof opts.created_by === "string" &&
      containsControlChars(opts.created_by)
    ) {
      throw new InvalidMessageError([
        "created_by must not contain control characters",
      ]);
    }
    const state: ChannelState = {
      descriptor: {
        channel: opts.channel,
        kind: "ephemeral",
        purpose: opts.purpose,
        verbosity: opts.verbosity ?? "quiet",
        created_by: opts.created_by,
        created_ts: this.#stamp(),
        head: 0,
      },
      log: [],
      claimLedger: new Map(),
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
    const end = limit === undefined ? head : Math.min(head, cursor + limit);
    const messages = state.log.slice(cursor, end);
    return { messages, cursor: cursor + messages.length };
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
    // `now` once so the check and the in-branch record use the same instant.
    // Claims are NOT dup-checked: the ledger's `already_claimed` IS the dedup
    // answer for a repeated claim, so a duplicate_post throw would be redundant
    // and would mask the real (claim) outcome. Synchronous — no `await`, so the
    // critical section below stays a true compare-and-set.
    const now = this.#seatbelt.now();
    this.#seatbelt.checkRate(channel, msg.agent_id, now);

    // ---- BEGIN critical section: NO `await` between the ledger read and the
    // ---- ledger write. This is the first-write-wins compare-and-set. When
    // ---- durability lands this MUST become a single transaction / unique
    // ---- constraint, never a read-then-write across an `await`.
    const existing = state.claimLedger.get(key);
    if (existing !== undefined) {
      // Loser: consumes NO rate budget (we never called recordRate).
      return {
        outcome: "already_claimed",
        by: {
          agent_id: existing.agent_id,
          owner: existing.owner,
          ts: existing.ts,
          msg_id: existing.msg_id,
        },
      };
    }
    const message = this.#appendSync(state, validated);
    state.claimLedger.set(key, {
      agent_id: message.agent_id,
      owner: message.owner,
      ts: message.ts,
      msg_id: message.msg_id,
    });
    // Winner: record the post against the rate window now that it's committed.
    this.#seatbelt.recordRate(channel, msg.agent_id, now);
    // ---- END critical section ----

    return { outcome: "granted", message, cursor: state.descriptor.head };
  }

  async subscribe(channel: string): Promise<Cursor> {
    return this.#requireChannel(channel).descriptor.head;
  }
}
