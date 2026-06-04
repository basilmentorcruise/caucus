/**
 * `InMemoryBackbone` — the reference {@link Backbone} implementation (CAU-4).
 *
 * Pure in-process state: an event log plus two projections (a mutable channel
 * descriptor and a claim ledger) per channel. It is the substrate the unit and
 * integration tests run against, and the executable specification of the
 * contract's semantics. NO HTTP, NO durability, NO seatbelts, NO identity
 * anchoring, NO lease enforcement — those are CAU-5/6/7/18.
 *
 * The whole-ballgame property is claim atomicity: `claim()` performs all
 * validation and all `await`s BEFORE entering a critical section, then reads and
 * writes the ledger with no `await` in between, so the check-then-append is
 * effectively a compare-and-set. When durability lands (SQLite) the same
 * read-then-write MUST become a single transaction / unique-constraint upsert —
 * never a read-then-write spanning an `await`. See `docs/BACKBONE_CONTRACT.md`.
 */
import {
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

/** Maximum number of characters allowed in a message `body` at the boundary. */
export const MAX_BODY_CHARS = 16_000;

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
   * Monotonic counter backing the `ts` stamp. Bare `Date.toISOString()` ties
   * under a tight loop (same millisecond), which would break the
   * strictly-increasing `ts` guarantee; we append a zero-padded sequence so each
   * stamp is unique and ordered. The result is still a sortable ISO-ish string.
   */
  #seq = 0;

  /**
   * Produce a server-monotonic timestamp. Strictly increasing across calls,
   * independent of clock resolution.
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
    return stamped;
  }

  /**
   * Synchronously append an already-validated, version-stamped message to a
   * channel log, stamping `ts` and advancing the head. Returns the appended
   * message. NO `await` inside — used directly within the claim critical
   * section.
   */
  #appendSync(state: ChannelState, message: CaucusMessage): AppendedMessage {
    const appended: AppendedMessage = { ...message, ts: this.#stamp() };
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

    // ---- BEGIN critical section: NO `await` between the ledger read and the
    // ---- ledger write. This is the first-write-wins compare-and-set. When
    // ---- durability lands this MUST become a single transaction / unique
    // ---- constraint, never a read-then-write across an `await`.
    const existing = state.claimLedger.get(key);
    if (existing !== undefined) {
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
    // ---- END critical section ----

    return { outcome: "granted", message, cursor: state.descriptor.head };
  }

  async subscribe(channel: string): Promise<Cursor> {
    return this.#requireChannel(channel).descriptor.head;
  }
}
