/**
 * `caucus_subscribe` — mint a "now" cursor (CAU-11).
 *
 * Subscribing mints a cursor at the channel's CURRENT head and returns it. It
 * is the bookmark an agent (or the CAU-14 turn-start hook) drops before it
 * starts work, then passes back as `since` to {@link readChannelTool} to see
 * only what arrives afterward.
 *
 * It is read-only (posts nothing — ADR-C6) and holds NO server-side
 * subscription: the backbone's `subscribe` is a stateless cursor-mint, not a
 * durable stream. It also does not replay history — for catch-up, call
 * `caucus_read_channel` with no `since`.
 *
 * Unknown-channel handling is a DELIBERATE divergence from
 * {@link readChannelTool}, which tolerates a not-yet-created channel by
 * returning an empty page. A read of a missing room is harmless catch-up; but
 * subscribing to a room that does not exist means the agent's mental model is
 * wrong (typo'd channel, room never created), and every subsequent
 * read-since against that bookmark would silently return nothing. So we let
 * `UnknownChannelError` propagate and fail loudly here. Do NOT "fix" this to
 * mirror read-channel's tolerance — the divergence is the point.
 */
import type { CaucusSession } from "../session.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** The `caucus_subscribe` tool. */
export const subscribeTool: CaucusTool = {
  name: "caucus_subscribe",
  description:
    "Mark 'now' in the Caucus channel: mints a cursor at the current head " +
    "and returns {cursor}. Read-only — posts nothing (ADR-C6). Call it " +
    "before you start work, then pass the cursor as `since` to " +
    "caucus_read_channel to see only what arrives afterward. It does NOT " +
    "replay history (use caucus_read_channel with no `since` for that) and " +
    "holds no server-side subscription — it's just a starting bookmark.",
  inputSchema: {},
  async handle(session: CaucusSession): Promise<ToolResult> {
    // UnknownChannelError propagates by design (see module note) — a missing
    // room must fail loudly, not silently mint a dead bookmark.
    const cursor = await session.reader.subscribe(session.channel);
    return { content: [{ type: "text", text: JSON.stringify({ cursor }) }] };
  },
};
