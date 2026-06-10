/**
 * Channel discovery + ephemeral war-room create/join tools (CAU-12).
 *
 * Four read-mostly tools that let an agent find existing war rooms, inspect one,
 * spin up a new ephemeral room, and get a read cursor on a room other than the
 * one it posts to:
 *
 * - `caucus_list_channels` / `caucus_describe_channel` are pure reads off
 *   {@link CaucusSession.reader}. They teach *discovery before create*: an
 *   investigation should converge on ONE room, so check what exists before
 *   minting another.
 * - `caucus_create_channel` is the one WRITE here. It does NOT go through the
 *   reader (which deliberately omits `createChannel`); it calls {@link
 *   CaucusSession.createChannel}, which anchors `created_by` to the session
 *   owner server-side — a tool cannot forge attribution because there is no
 *   `created_by` argument to forge (ADR-C7).
 * - `caucus_join_channel` mints a read cursor on a room AND opens the
 *   cross-room posting gate for it (CAU-92): after joining X, this session may
 *   post/claim into X via the tools' `channel` arg. The session's POSTING HOME
 *   stays fixed by `CAUCUS_CHANNEL` (a per-call override, not a re-bind, so the
 *   hook keeps following home); cross-room posting is join-gated and
 *   quiet-by-default (ADR-C6 addendum). A bare `caucus_read_channel({channel})`
 *   does NOT open the gate — only a deliberate join does, keeping it the
 *   explicit, auditable act.
 *
 * Unknown-channel handling DIFFERS per tool on purpose: describe and join let
 * {@link UnknownChannelError} propagate (a missing room is the answer to "does
 * this exist?" / a join of a non-existent room must fail loudly), unlike
 * `caucus_read_channel` which tolerates a missing room as empty catch-up. Do NOT
 * unify these.
 *
 * Secret hygiene (ADR-C12): the channel set + purposes are a shared, persisted,
 * human-facing log. `purpose` must never carry secrets, and nothing here
 * interpolates a channel name or purpose into an error string (the backbone's
 * errors are value-free). The read tools also pass the poster-controlled
 * descriptor free-text (`purpose`, `created_by`) through `stripControlChars`
 * before serializing it into another agent's model context, so a token-holding
 * poster cannot smuggle a terminal/C1 escape via a channel descriptor (CAU-73 —
 * `JSON.stringify` does not escape C1 bytes).
 */
import { z } from "zod";
import {
  stripControlChars,
  stripControlCharsKeepWhitespace,
} from "@caucus/schema";
import type { ChannelDescriptor } from "@caucus/backbone";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** Wrap a JSON-serializable payload in the standard text result envelope. */
function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

/**
 * Neutralize terminal control characters in the poster-controlled free-text
 * descriptor fields before serializing a descriptor into another agent's model
 * context (CAU-73). `purpose` is caller-supplied free text — the same
 * C1-injectable class as a message `body` — and `created_by` is a resolved owner
 * label; both are emitted raw via `JSON.stringify` by `caucus_list_channels` and
 * `caucus_describe_channel`, and `JSON.stringify` does NOT escape C1 bytes
 * (`\x80–\x9f`). `purpose` may be multi-line, so it keeps `\n`/`\t`
 * (terminal-inert under JSON, useful structure); `created_by` is a single-token
 * label, so it uses the plain strip. The structural/validated fields
 * (`channel`/`kind`/`verbosity`/`created_ts`/`head`) are left untouched.
 */
function sanitizeDescriptor(d: ChannelDescriptor): ChannelDescriptor {
  return {
    ...d,
    purpose: stripControlCharsKeepWhitespace(d.purpose),
    created_by: stripControlChars(d.created_by),
  };
}

/** The `caucus_list_channels` tool. */
export const listChannelsTool: CaucusTool = {
  name: "caucus_list_channels",
  description:
    "List the existing Caucus war rooms (channels) with their descriptors " +
    "({channel, purpose, kind, created_by, created_ts, head}). Read-only: " +
    "posts nothing (ADR-C6). Use it to DISCOVER an existing room before you " +
    "create a new one — an investigation should converge on a single shared " +
    "room, not fragment across duplicates. Returns {count, channels}.",
  inputSchema: {},
  async handle(session: CaucusSession): Promise<ToolResult> {
    const channels = await session.reader.listChannels();
    // Sanitize each descriptor's poster-controlled free-text (purpose) and
    // owner label before serializing into the model context (CAU-73). `count`
    // is taken before mapping so it is unaffected.
    return jsonResult({
      count: channels.length,
      channels: channels.map(sanitizeDescriptor),
    });
  },
};

/** The input schema for `caucus_describe_channel`: optional `channel`. */
const DESCRIBE_CHANNEL_INPUT = {
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Channel (war room) to describe. Absent ⇒ your own session channel. " +
        "An unknown channel is an error — that IS the answer to 'does this " +
        "room exist?'.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_describe_channel` args (validated by the SDK before `handle`). */
interface DescribeChannelArgs {
  readonly channel?: string;
}

/** The `caucus_describe_channel` tool. */
export const describeChannelTool: CaucusTool = {
  name: "caucus_describe_channel",
  description:
    "Describe one Caucus war room (channel): returns its descriptor " +
    "({channel, purpose, kind, created_by, created_ts, head}). Read-only: " +
    "posts nothing (ADR-C6). Omit `channel` to describe your own session " +
    "channel. Use it (with caucus_list_channels) to CHECK an existing room " +
    "before creating a new one. An unknown channel is reported as an error — " +
    "that is the honest answer to whether the room exists.",
  inputSchema: DESCRIBE_CHANNEL_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { channel } = args as DescribeChannelArgs;
    // UnknownChannelError propagates by design (see module note): a missing
    // room is the answer, not a tolerated empty result. The backbone's error
    // is value-free, so nothing here interpolates the channel name (ADR-C12).
    const descriptor = await session.reader.describeChannel(
      channel ?? session.channel,
    );
    // Sanitize the poster-controlled free-text (purpose) and owner label before
    // serializing into the model context (CAU-73).
    return jsonResult(sanitizeDescriptor(descriptor));
  },
};

/** The input schema for `caucus_create_channel`: `channel` + `purpose`. */
const CREATE_CHANNEL_INPUT = {
  channel: z
    .string()
    .min(1)
    .describe(
      "Name of the new war room. Slug rule: ^[a-z0-9][a-z0-9-]{0,63}$ " +
        "(lowercase letters/digits/hyphens, starts alphanumeric, ≤64 chars). " +
        "Required, non-empty. Creating a duplicate is an error — discover " +
        "first with caucus_list_channels.",
    ),
  purpose: z
    .string()
    .min(1)
    .describe(
      "Human-facing statement of what this room is investigating (e.g. " +
        '"checkout 500s spike, 2026-06-04"). Required, non-empty. No secrets ' +
        "(ADR-C12) — purposes are stored verbatim in the shared log.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_create_channel` args (validated by the SDK before `handle`). */
interface CreateChannelArgs {
  readonly channel: string;
  readonly purpose: string;
}

/** The `caucus_create_channel` tool. */
export const createChannelTool: CaucusTool = {
  name: "caucus_create_channel",
  description:
    "Create a new EPHEMERAL war room (channel) for an investigation/" +
    "escalation (ADR-C10) and return its descriptor. FIRST check existing " +
    "rooms with caucus_list_channels — an investigation should share ONE room, " +
    "not fragment across duplicates; a duplicate name is an error. The room is " +
    "attributed to you automatically (created_by = your owner); you cannot set " +
    "it. Name must match ^[a-z0-9][a-z0-9-]{0,63}$. Put the investigation focus " +
    "in `purpose` — never secrets (ADR-C12).",
  inputSchema: CREATE_CHANNEL_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { channel, purpose } = args as unknown as CreateChannelArgs;
    // created_by is anchored to the session owner inside createChannel — there
    // is no created_by argument here, so attribution cannot be forged. An
    // invalid slug / duplicate name propagates the backbone's value-free error
    // untouched (ADR-C12): nothing interpolates `channel`/`purpose`.
    const descriptor = await session.createChannel({ channel, purpose });
    return jsonResult(descriptor);
  },
};

/** The input schema for `caucus_join_channel`: required `channel`. */
const JOIN_CHANNEL_INPUT = {
  channel: z
    .string()
    .min(1)
    .describe(
      "War room (channel) to join. Must already exist — joining a " +
        "non-existent room is an error.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_join_channel` args (validated by the SDK before `handle`). */
interface JoinChannelArgs {
  readonly channel: string;
}

/** The `caucus_join_channel` tool. */
export const joinChannelTool: CaucusTool = {
  name: "caucus_join_channel",
  description:
    "Join an existing Caucus war room: verifies it exists, mints a read cursor " +
    "at its current head, and authorizes this session to post into it — " +
    "returning {channel, cursor, head}. Join a room to READ it AND to be " +
    "ALLOWED to post into it (sparingly, ADR-C6): after joining, set `channel` " +
    "on caucus_post / caucus_post_finding / caucus_steer / caucus_claim to that " +
    "room. Your posting HOME stays fixed by CAUCUS_CHANNEL — this is a per-call " +
    "override, not a re-bind. To follow the room, call caucus_read_channel with " +
    "`channel` set and the returned `cursor` as `since`. A bare read does NOT " +
    "authorize posting — only this join does. Joining a non-existent room is an " +
    "error.",
  inputSchema: JOIN_CHANNEL_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { channel } = args as unknown as JoinChannelArgs;
    // subscribe() both verifies the room exists (UnknownChannelError
    // propagates for a typo'd/non-existent channel — same rationale as
    // caucus_subscribe's divergence from caucus_read_channel) and mints the
    // cursor at the current head in ONE call, so cursor === head is atomic by
    // construction rather than racing a separate describeChannel.
    const cursor = await session.reader.subscribe(channel);
    // Only AFTER a successful subscribe (the room provably exists) do we open
    // the cross-room posting gate for it (CAU-92). This is the SOLE caller of
    // noteJoined — a bare caucus_read_channel({channel}) deliberately does not
    // reach it, so "join" stays the explicit, auditable act that authorizes
    // posting into another room.
    session.noteJoined(channel);
    return jsonResult({ channel, cursor, head: cursor });
  },
};
