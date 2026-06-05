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
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_read_channel` args (validated by the SDK before `handle`). */
interface ReadChannelArgs {
  readonly since?: number;
  readonly limit?: number;
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
    "`limit` to cap volume.",
  inputSchema: READ_CHANNEL_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { since, limit } = args as ReadChannelArgs;
    try {
      const { messages, cursor } = await session.reader.readSince(
        session.channel,
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
