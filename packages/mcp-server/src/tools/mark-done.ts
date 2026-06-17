/**
 * `caucus_mark_done` — mark a claim you hold as finished, freeing the target
 * (CAU-18, the ADR-C5 explicit done-state transition).
 *
 * Only the current holder, matched server-side on the anchored `owner`
 * (ADR-C7), may finish a claim. On success a `status:"resolved"` `claim`
 * message is posted (a VISIBLE record of completion — unlike a silent lease
 * lapse) and the ledger entry is removed, so the target is freshly claimable.
 *
 * Three outcomes, all normal results (never `isError`):
 * - `granted`: you held the target; it is now resolved and free.
 * - `already_claimed`: a DIFFERENT owner holds it — you cannot close someone
 *   else's claim. A no-op; `by` names the holder.
 * - `not_held`: the target is unheld / never-claimed / already lapsed — a no-op
 *   with nothing posted.
 *
 * Secret hygiene (ADR-C12): the description forbids secrets; a rejected call
 * propagates the backbone's value-free error untouched — nothing here
 * interpolates `target`/`note`. `already_claimed.by` is sanitized exactly as
 * `caucus_claim` does.
 */
import { z } from "zod";
import { normalizeTarget, stripControlChars } from "@caucus/schema";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { ToolMessageDraft } from "../identity.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** The input schema for `caucus_mark_done`. */
const MARK_DONE_INPUT = {
  target: z
    .string()
    .min(1)
    .describe(
      "The work item / hypothesis you hold and have finished (normalized: " +
        "trim + Unicode NFC, exactly as caucus_claim). You must be the current " +
        "holder. No secrets.",
    ),
  note: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Short human-readable summary of the outcome / resolution. No secrets.",
    ),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target room. Absent ⇒ your session channel. To act in another room you " +
        "must have joined it first with caucus_join_channel.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_mark_done` args (validated by the SDK before `handle`). */
interface MarkDoneArgs {
  readonly target: string;
  readonly note?: string;
  readonly channel?: string;
}

/** The `caucus_mark_done` tool. */
export const markDoneTool: CaucusTool = {
  name: "caucus_mark_done",
  description:
    "Mark a target you hold as DONE, freeing it for re-claim (CAU-18, ADR-C5). " +
    "Posts a status:resolved message so everyone sees the work finished. " +
    "Returns outcome=granted on success; outcome=already_claimed if a " +
    "different owner holds it (you can't close someone else's claim); " +
    "outcome=not_held if nobody holds it. Put the resolution in `note`; never " +
    "include secrets (ADR-C12).",
  inputSchema: MARK_DONE_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const doneArgs = args as unknown as MarkDoneArgs;
    const target = normalizeTarget(doneArgs.target);
    const trimmedNote = doneArgs.note?.trim();
    const body =
      trimmedNote !== undefined && trimmedNote.length > 0
        ? trimmedNote
        : `resolved ${target}`;
    const draft = { type: "claim", target, body } as ToolMessageDraft;
    const result = await session.markClaimDone(draft, doneArgs.channel);
    if (result.outcome === "granted") {
      const payload = {
        outcome: "granted",
        msg_id: result.message.msg_id,
        cursor: result.cursor,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    if (result.outcome === "not_held") {
      const payload = { outcome: "not_held" };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    // Sanitize the poster-controlled identity fields before they land in this
    // caller's model context (CAU-73), exactly as caucus_claim does.
    const payload = {
      outcome: "already_claimed",
      by: {
        ...result.by,
        agent_id: stripControlChars(result.by.agent_id),
        owner: stripControlChars(result.by.owner),
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(payload) }] };
  },
};
