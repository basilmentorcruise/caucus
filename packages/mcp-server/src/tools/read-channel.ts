/**
 * `caucus_read_channel` — the catch-up read tool (CAU-10).
 *
 * Returns channel messages in append order, with identity (agent_id/owner) and
 * type, so the model can see who is on what before it claims, posts, or starts
 * work (ADR-C5). It is read-only (posts nothing — ADR-C6) and holds no cursor
 * state: the agent passes the returned `cursor` back as `since` to get only
 * what's new. The CAU-14 hook keeps its own cursor independently of this tool.
 *
 * Cursor semantics (coordinator-ratified): `since` is an opaque numeric cursor;
 * omitting it means read from the channel start (`0`). A not-yet-created
 * channel is not an error for a read — it yields an empty page at cursor `0`.
 *
 * `channel` (CAU-12): optional override so a cursor minted by
 * caucus_join_channel is actually consumable — reads default to the session
 * channel but may follow any existing room. Reads are identity-free and the
 * posting channel stays fixed by CAUCUS_CHANNEL (writes are unaffected).
 */
import { z } from "zod";
import { UnknownChannelError } from "@caucus/backbone";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** The input schema for `caucus_read_channel`: `since` and `limit`, both optional. */
const READ_CHANNEL_INPUT = {
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Opaque numeric cursor from a prior read's `cursor` field. Absent ⇒ " +
        "read from the channel start.",
    ),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum messages to return. Absent ⇒ all new messages. Use it to stay " +
        "within context budget.",
    ),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Channel to read. Absent ⇒ your session channel. Pass a room you " +
        "joined via caucus_join_channel (with its cursor as `since`) to " +
        "follow it.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_read_channel` args (validated by the SDK before `handle`). */
interface ReadChannelArgs {
  readonly since?: number;
  readonly limit?: number;
  readonly channel?: string;
}

/** The `caucus_read_channel` tool. */
export const readChannelTool: CaucusTool = {
  name: "caucus_read_channel",
  description:
    "Read Caucus channel messages. Read-only: posts nothing. Call this to " +
    "catch up BEFORE you claim, post, or start work — so you don't duplicate " +
    "a teammate's claim or re-report a known finding (ADR-C5). Returns " +
    "messages in append order with identity (agent_id/owner) and type, so " +
    "you can see who is on what. Omit `since` to read from the beginning; " +
    "pass back the returned `cursor` as `since` to get only what's new. Use " +
    "`limit` to cap volume; use `channel` to read a room you joined " +
    "(default: your session channel).",
  inputSchema: READ_CHANNEL_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { since, limit, channel } = args as ReadChannelArgs;
    try {
      const { messages, cursor } = await session.reader.readSince(
        channel ?? session.channel,
        since ?? 0,
        limit,
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ cursor, count: messages.length, messages }),
          },
        ],
      };
    } catch (err) {
      // A not-yet-created channel is not an error for a read: report an empty
      // page at cursor 0, mirroring caucus_status's tolerance of a missing
      // channel. Anything else is unexpected and propagates untouched (the
      // backbone's error messages are value-free — ADR-C12).
      if (err instanceof UnknownChannelError) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ cursor: 0, count: 0, messages: [] }),
            },
          ],
        };
      }
      throw err;
    }
  },
};
