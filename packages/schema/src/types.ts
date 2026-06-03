/**
 * Pure type definitions for schema v0. No runtime values live here — value
 * sets are in `constants.ts`, validation in `validate.ts`.
 */
import type { MESSAGE_TYPES, STATUS_VALUES } from "./constants.js";
import type { SCHEMA_VERSION } from "./version.js";

/** One of the fixed message intents. */
export type MessageType = (typeof MESSAGE_TYPES)[number];

/** One of the optional coordination signals. */
export type StatusValue = (typeof STATUS_VALUES)[number];

/**
 * Fields common to every message *as authored by a caller* (the input form).
 *
 * `agent_id`/`owner` are carried here but anchored server-side (ADR-C7) — the
 * codec never sets or auth-checks them. `ts` is server-stamped on append and is
 * therefore absent from the input form (see `CaucusMessage`).
 */
export interface BaseMessageInput {
  /** The message's intent. Drives hook rendering and human scanning. */
  type: MessageType;
  /** Stable id of the posting agent (session). */
  agent_id: string;
  /** The human the agent acts for. Anchored server-side (ADR-C7). */
  owner: string;
  /** Unique, sortable ULID; the target of replies/refs. */
  msg_id: string;
  /** Concise human-readable text. Unbounded by the codec in v0. */
  body: string;
  /** Root message (ULID) of the thread. Absent ⇒ starts a thread. */
  thread?: string;
  /** The specific message (ULID) being replied to. */
  reply_to?: string;
  /** Addressing: agent_ids this is for. Absent ⇒ for the channel. */
  to?: string[];
  /** Coordination signal; lets a thread explicitly end. */
  status?: StatusValue;
  /** Link to full content when `body` is a summary. */
  artifact?: string;
}

/**
 * A `claim` message. `target` is required; `lease_ttl`/`heartbeat` ship in v0
 * but their enforcement is deferred to CAU-18 (M2, ADR-C5 amendment).
 */
export interface ClaimMessageInput extends BaseMessageInput {
  type: "claim";
  /** The work item / hypothesis being claimed (first-write-wins). */
  target: string;
  /** Seconds a claim holds without a heartbeat before it lapses. */
  lease_ttl?: number;
  /** Marks a keep-alive that renews an existing lease. */
  heartbeat?: boolean;
}

/**
 * The authored form of any message. `target` (and the claim-only fields) are
 * permitted only on `claim`; the codec rejects them on other types at runtime,
 * and `target?: never` rejects them at the type level.
 */
export type MessageInput =
  | ClaimMessageInput
  | (BaseMessageInput & {
      type: Exclude<MessageType, "claim">;
      target?: never;
      lease_ttl?: never;
      heartbeat?: never;
    });

/**
 * A message after the codec has stamped `v`. `ts` is optional: it is absent on
 * a freshly-encoded message and present once the backbone has appended it.
 */
export type CaucusMessage = MessageInput & {
  v: typeof SCHEMA_VERSION;
  ts?: string;
};
