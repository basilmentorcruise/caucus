/**
 * `caucus_catch_me_up` — the incident-commander catch-up + postmortem-skeleton
 * tool (CAU-19).
 *
 * A deterministic, structured projection of the typed log over a cursor window.
 * It is READ-ONLY (posts nothing — ADR-C6) and holds no cursor state: it returns
 * the end cursor so an IC can take repeated incremental catch-ups. There is NO
 * model call here (and none server-side, by design): the requesting agent's own
 * Claude Code session narrates the projection into prose if a human wants prose,
 * so the server stays the LLM-free substrate (ADR-C2) and never holds a provider
 * key (ADR-C12). The computation lives in the pure {@link buildDigest} /
 * {@link renderDigestMarkdown} module; this file is the thin I/O seam.
 *
 * It drains the WHOLE window: `readSince` caps each page (default 500), so a
 * single page may not cover a 600-message war room. The handler loops
 * `readSince` from the caller's `since` until a page comes back empty, so the
 * digest summarizes the entire backlog after `since`, not just one page. It
 * breaks on a non-advancing cursor as a safety stop (a well-behaved backbone
 * never returns a non-empty page without advancing, but the loop must not spin).
 *
 * A not-yet-created channel is NOT an error for a read (mirrors
 * `caucus_read_channel`): {@link UnknownChannelError} is tolerated as an empty
 * digest. `describeChannel` failure (e.g. the channel vanished mid-call) is
 * tolerated as a title fallback — the digest still renders.
 */
import { z } from "zod";
import { UnknownChannelError } from "@caucus/backbone";
import type { AppendedMessage } from "@caucus/backbone";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { CaucusTool, ToolResult } from "./registry.js";
import { buildDigest, renderDigestMarkdown } from "../digest.js";

/** The input schema for `caucus_catch_me_up`: `since`, `channel`, `format`. */
const CATCH_ME_UP_INPUT = {
  since: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "Opaque numeric cursor from a prior digest's `to_cursor` (structured) or " +
        "`since=N` footer (markdown). Absent ⇒ summarize from the channel " +
        "start. Pass it back to take an incremental catch-up of only what's new.",
    ),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Channel (war room) to summarize. Absent ⇒ your session channel. Pass a " +
        "room you joined via caucus_join_channel to summarize it.",
    ),
  format: z
    .enum(["structured", "markdown"])
    .default("structured")
    .describe(
      "`structured` (default) returns the JSON projection for you to read and " +
        "narrate to your human; `markdown` returns a copy-pasteable postmortem " +
        "skeleton — the human-handoff trigger: reach for it when a human asks to " +
        "export, write up, or hand off the war room.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_catch_me_up` args (validated by the SDK before `handle`). */
interface CatchMeUpArgs {
  readonly since?: number;
  readonly channel?: string;
  readonly format?: "structured" | "markdown";
}

/**
 * Drain the whole window from `since`, looping `readSince` until a page is empty
 * (or the cursor stops advancing — a safety stop against a misbehaving page).
 * Returns every message after `since` in append order plus the end cursor.
 */
async function drainWindow(
  session: CaucusSession,
  channel: string,
  since: number,
): Promise<{ messages: AppendedMessage[]; to_cursor: number }> {
  const messages: AppendedMessage[] = [];
  let cursor = since;
  for (;;) {
    const page = await session.reader.readSince(channel, cursor, undefined);
    if (page.messages.length === 0) break;
    messages.push(...page.messages);
    // Safety stop: a well-behaved backbone advances the cursor by the page size,
    // but never spin if it returns a non-empty page without advancing.
    if (page.cursor <= cursor) break;
    cursor = page.cursor;
  }
  return { messages, to_cursor: cursor };
}

/** The `caucus_catch_me_up` tool. */
export const catchMeUpTool: CaucusTool = {
  name: "caucus_catch_me_up",
  description:
    "Catch up on (or export) a Caucus war room. Returns the SYNTHESIZED state " +
    "of the investigation — who's on what, what's open, the key findings — NOT " +
    "the raw message scroll (for that, use caucus_read_channel). Read-only: " +
    "posts NOTHING (ADR-C6). It is a deterministic, structured projection of " +
    "the channel over a cursor window — message counts by type, participants, " +
    "open/resolved claims, unanswered questions, and a timeline of findings — " +
    "so you can see the state of an investigation 40 messages deep WITHOUT " +
    "re-reading the raw scroll. `format: \"structured\"` (default) returns " +
    "JSON for you to read and narrate; `format: \"markdown\"` returns a copy-" +
    "pasteable postmortem skeleton for a human. Omit `since` to summarize from " +
    "the start; pass back the returned `to_cursor` (structured) or `since=N` " +
    "footer (markdown) as `since` to take an incremental catch-up of only " +
    "what's new. Use `channel` to summarize a room you joined (default: your " +
    "session channel). It drains the whole window, not one page, and there is " +
    "no model call: it is a pure projection — narrate the result yourself.",
  inputSchema: CATCH_ME_UP_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { since, channel, format } = args as CatchMeUpArgs;
    const ch = channel ?? session.channel;
    const from_cursor = since ?? 0;
    const fmt = format ?? "structured";

    let messages: AppendedMessage[] = [];
    let to_cursor = from_cursor;
    try {
      const drained = await drainWindow(session, ch, from_cursor);
      messages = drained.messages;
      to_cursor = drained.to_cursor;
    } catch (err) {
      // A not-yet-created channel is not an error for a read: an empty digest
      // at the start cursor, mirroring caucus_read_channel. Anything else is
      // unexpected and propagates untouched (backbone errors are value-free —
      // ADR-C12).
      if (!(err instanceof UnknownChannelError)) throw err;
    }

    const digest = buildDigest(messages, { from_cursor, to_cursor });

    if (fmt === "markdown") {
      // Best-effort title: describeChannel may fail (the channel could have
      // vanished, or never existed for an empty digest) — tolerate it as a
      // no-descriptor title fallback so the markdown still renders.
      let descriptor: { channel: string; purpose?: string } | undefined;
      try {
        const d = await session.reader.describeChannel(ch);
        descriptor = { channel: d.channel, purpose: d.purpose };
      } catch {
        descriptor = { channel: ch };
      }
      return {
        content: [{ type: "text", text: renderDigestMarkdown(digest, descriptor) }],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(digest) }],
    };
  },
};
