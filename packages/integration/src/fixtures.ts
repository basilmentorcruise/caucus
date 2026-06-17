/**
 * Message-builder helpers for scenarios (CAU-25).
 *
 * Scenarios shouldn't hand-roll `MessageInput` (and must not forget the ULID
 * `msg_id`), so these builders mint a fresh id via `@caucus/schema`'s `newMsgId`
 * and fill the required envelope. Each call returns a NEW message with a unique
 * `msg_id`.
 */
import { newMsgId, type MessageInput } from "@caucus/schema";

/** Optional overrides for the common envelope fields a scenario may want to set. */
export interface MessageOpts {
  /** Defaults to `"note"` for findings / `"claiming <target>"` for claims. */
  readonly body?: string;
  /** Claim only (CAU-18): lease length in seconds before lapse without heartbeat. */
  readonly lease_ttl?: number;
  /** Claim only (CAU-18): mark a keep-alive that renews the holder's lease. */
  readonly heartbeat?: boolean;
}

/**
 * A non-claim `finding` authored by `agentId` on behalf of `owner`, with a
 * fresh ULID `msg_id`.
 */
export function finding(
  agentId: string,
  owner: string,
  opts: MessageOpts = {},
): MessageInput {
  return {
    type: "finding",
    agent_id: agentId,
    owner,
    msg_id: newMsgId(),
    body: opts.body ?? "note",
  };
}

/**
 * A `steer` (human-directive) message authored by `agentId` on behalf of
 * `owner`, with a fresh ULID `msg_id` (CAU-99). Goes through `Backbone.append`
 * like a finding.
 */
export function steer(
  agentId: string,
  owner: string,
  opts: MessageOpts = {},
): MessageInput {
  return {
    type: "steer",
    agent_id: agentId,
    owner,
    msg_id: newMsgId(),
    body: opts.body ?? "human steer",
  };
}

/**
 * A `claim` message for `target` authored by `agentId` on behalf of `owner`,
 * with a fresh ULID `msg_id`. Goes through `Backbone.claim`, never `append`.
 */
export function claimMsg(
  agentId: string,
  owner: string,
  target: string,
  opts: MessageOpts = {},
): MessageInput {
  const msg: MessageInput = {
    type: "claim",
    agent_id: agentId,
    owner,
    msg_id: newMsgId(),
    body: opts.body ?? `claiming ${target}`,
    target,
  };
  // CAU-18 lease fields: copy only when present so a plain claim stays byte-equal.
  if (opts.lease_ttl !== undefined) msg.lease_ttl = opts.lease_ttl;
  if (opts.heartbeat !== undefined) msg.heartbeat = opts.heartbeat;
  return msg;
}
