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
 * - `caucus_join_channel` is read-only: "joining" a room == minting a cursor on
 *   it. The session's POSTING channel is fixed by `CAUCUS_CHANNEL`; join only
 *   yields a read cursor on another room (switching the posting channel is out
 *   of scope for M1).
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
 * errors are value-free).
 */
import { z } from "zod";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** Wrap a JSON-serializable payload in the standard text result envelope. */
function jsonResult(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
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
    return jsonResult({ count: channels.length, channels });
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
    return jsonResult(descriptor);
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
    "Join an existing Caucus war room: verifies it exists and mints a read " +
    "cursor at its current head, returning {channel, cursor, head}. Read-only: " +
    "posts nothing (ADR-C6). IMPORTANT: your POSTING channel is fixed by " +
    "CAUCUS_CHANNEL — join does NOT switch where you post; it only gives you a " +
    "read cursor on another room. Pass the returned `cursor` as `since` to " +
    "caucus_read_channel to follow that room. Joining a non-existent room is " +
    "an error.",
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
    return jsonResult({ channel, cursor, head: cursor });
  },
};
