/**
 * `caucus_reassign` — hand a live claim to a teammate (CAU-18, the ADR-C5
 * reassignment transition).
 *
 * The CURRENT holder calls this to pass a `target` they own to a new holder.
 * Authorization is server-side: the session stamps the caller's anchored
 * identity (ADR-C7), and the backbone grants the reassignment only when the
 * caller's `owner` matches the current holder — a different owner gets
 * `already_claimed`, an unheld/lapsed target degrades to a fresh claim by the
 * assignee. The reassignment posts a visible `claim` message authored by the
 * (authenticated) handing-off holder, so everyone sees who handed what to whom.
 *
 * The assignee is NAMED, not anchored: `assignee_agent`/`assignee_owner` are
 * poster-asserted data the authenticated holder vouches for (like a `to[]`
 * recipient). They become the new ledger holder.
 *
 * Secret hygiene (ADR-C12): the channel is a shared, persisted log. The
 * description forbids secrets, and a rejected reassign propagates the backbone's
 * value-free error untouched — nothing here interpolates `target`/`note`/
 * `assignee` into an error string. `already_claimed.by` is sanitized exactly as
 * `caucus_claim` does before it lands in the caller's context.
 */
import { z } from "zod";
import { normalizeTarget, stripControlChars } from "@caucus/schema";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { ToolMessageDraft } from "../identity.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** The input schema for `caucus_reassign`. */
const REASSIGN_INPUT = {
  target: z
    .string()
    .min(1)
    .describe(
      "The work item / hypothesis you currently hold and want to hand off " +
        "(normalized: trim + Unicode NFC, exactly as caucus_claim). You must " +
        "be the current holder. No secrets.",
    ),
  assignee_owner: z
    .string()
    .min(1)
    .describe(
      "The human (owner) the claim is being handed to — the new holder. " +
        "Poster-asserted (you vouch for it); becomes the ledger holder.",
    ),
  assignee_agent: z
    .string()
    .min(1)
    .describe(
      "The agent_id (session) of the new holder. Poster-asserted; becomes the " +
        "ledger holder alongside assignee_owner.",
    ),
  note: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Short human-readable reason / context for the handoff. No secrets.",
    ),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target room for this reassignment. Absent ⇒ your session channel. To " +
        "act in another room you must have joined it first with " +
        "caucus_join_channel. Claim ledgers are per-channel.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_reassign` args (validated by the SDK before `handle`). */
interface ReassignArgs {
  readonly target: string;
  readonly assignee_owner: string;
  readonly assignee_agent: string;
  readonly note?: string;
  readonly channel?: string;
}

/** The `caucus_reassign` tool. */
export const reassignTool: CaucusTool = {
  name: "caucus_reassign",
  description:
    "Reassign a target you hold to a teammate (CAU-18, ADR-C5). Only the " +
    "current holder can reassign; the handoff posts a visible claim message " +
    "and the ledger then points at the new holder. Returns outcome=granted on " +
    "success; outcome=already_claimed (with the current holder) if a different " +
    "owner holds the target — that is NOT a failure, it means you no longer " +
    "hold it. Name the new holder in assignee_owner/assignee_agent; never " +
    "include secrets (ADR-C12).",
  inputSchema: REASSIGN_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const reassignArgs = args as unknown as ReassignArgs;
    // Normalize the target here so the stored target and the ledger key agree
    // (the same load-bearing reason as caucus_claim). A whitespace-only target
    // throws the schema's MalformedMessageError at this layer.
    const target = normalizeTarget(reassignArgs.target);
    const trimmedNote = reassignArgs.note?.trim();
    const body =
      trimmedNote !== undefined && trimmedNote.length > 0
        ? trimmedNote
        : `reassigning ${target}`;
    const draft = { type: "claim", target, body } as ToolMessageDraft;
    const result = await session.reassignClaim(
      draft,
      {
        agent_id: reassignArgs.assignee_agent,
        owner: reassignArgs.assignee_owner,
      },
      reassignArgs.channel,
    );
    if (result.outcome === "granted") {
      const payload = {
        outcome: "granted",
        msg_id: result.message.msg_id,
        cursor: result.cursor,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    // reassignClaim returns only granted/already_claimed.
    if (result.outcome !== "already_claimed") {
      throw new Error("unexpected reassign outcome");
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
