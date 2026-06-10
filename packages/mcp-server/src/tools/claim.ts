/**
 * `caucus_claim` — the first-write-wins ownership tool (CAU-11, ADR-C5).
 *
 * A claim takes ownership of a `target` (a work item or hypothesis) BEFORE an
 * agent investigates it, so two agents in the same war room don't duplicate
 * effort. Claims route through {@link CaucusSession.claim} — the only path that
 * writes the claim ledger — so identity is stamped server-side (ADR-C7) and the
 * granted claim is appended to the channel in the same atomic step, visible to
 * everyone.
 *
 * Two outcomes, BOTH normal results (never `isError`):
 * - `granted`: this agent won. Returns `{outcome, msg_id, cursor}`.
 * - `already_claimed`: someone got there first. Returns `{outcome, by}` naming
 *   the current holder. Losing a claim is NOT a failure — it is the dedup
 *   working — so it must not surface as an error.
 *
 * Deliberately NOT exposed:
 * - `to`: claims are channel-wide coordination signals; targeting a claim at a
 *   subset of agents would defeat the point (everyone must see who owns what).
 * - `body`: derived from `note` (the schema requires a non-empty body on a
 *   claim), so the model never authors two overlapping fields.
 * - `lease_ttl` / `heartbeat`: claim-expiry enforcement is CAU-18; exposing
 *   dead knobs now would mislead the model into thinking they do something.
 *
 * Secret hygiene (ADR-C12): the channel is a shared, persisted log. The
 * description forbids secrets, and a rejected claim propagates the backbone's
 * value-free error untouched — nothing here interpolates `target` or `note`
 * into an error string.
 */
import { z } from "zod";
import { normalizeTarget, stripControlChars } from "@caucus/schema";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { ToolMessageDraft } from "../identity.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** The input schema for `caucus_claim`: `target`, plus optional `note`/`thread`/`reply_to`. */
const CLAIM_INPUT = {
  target: z
    .string()
    .min(1)
    .describe(
      "The work item / hypothesis you are taking ownership of (e.g. " +
        '"db-pool exhaustion" or "auth-timeout repro"). First-write-wins; ' +
        "normalized (trim + Unicode NFC) so spacing/Unicode-form variants " +
        "can't dodge dedup. Required, non-empty. No secrets.",
    ),
  note: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Short human-readable reason / scope for the claim (what you'll do, " +
        "how far it extends). No secrets.",
    ),
  thread: z
    .string()
    .optional()
    .describe(
      "msg_id (ULID) of the thread root this claim belongs to. Absent ⇒ " +
        "starts a new thread.",
    ),
  reply_to: z
    .string()
    .optional()
    .describe("msg_id (ULID) of the specific message you're replying to."),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target room for this claim. Absent ⇒ your session channel. To claim in " +
        "another room you must have joined it first with caucus_join_channel; " +
        "post sparingly into another team's room (ADR-C6). Claim ledgers are " +
        "per-channel — a target is independently claimable in each room.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_claim` args (validated by the SDK before `handle`). */
interface ClaimArgs {
  readonly target: string;
  readonly note?: string;
  readonly thread?: string;
  readonly reply_to?: string;
  /**
   * Target room (CAU-92). A ROUTING arg, NOT message content: it is threaded to
   * `session.claim` separately and never enters {@link buildClaimDraft}. Absent
   * ⇒ the session's home channel. (Note: `target` here is the CLAIM target — the
   * work item — which is unrelated to this routing `channel`.)
   */
  readonly channel?: string;
}

/**
 * Build a claim {@link ToolMessageDraft} from parsed args.
 *
 * The `target` is normalized here (trim + NFC) because this is load-bearing
 * for STORAGE: the schema codec stores `target` verbatim (it does not
 * normalize — see schema/src/target.ts), while the backbone derives its
 * ledger key separately. Normalizing here keeps the stored target and the
 * ledger key in agreement. Side effect: a whitespace-only target throws the
 * schema's MalformedMessageError at this layer, BEFORE the backbone would
 * have re-wrapped it as InvalidMessageError (see in-memory.ts) — the unit
 * test pins that error type deliberately. `body` is derived: the
 * schema requires a non-empty body on a claim, so we use a trimmed non-empty
 * `note` when present, else a generated `claiming ${target}`. Optional keys are
 * copied only when present, so we never spread `undefined` into the draft
 * (CAU-10 idiom).
 */
function buildClaimDraft(args: ClaimArgs): ToolMessageDraft {
  const target = normalizeTarget(args.target);
  const trimmedNote = args.note?.trim();
  const body =
    trimmedNote !== undefined && trimmedNote.length > 0
      ? trimmedNote
      : `claiming ${target}`;
  const draft = { type: "claim", target, body } as ToolMessageDraft;
  if (args.thread !== undefined) draft.thread = args.thread;
  if (args.reply_to !== undefined) draft.reply_to = args.reply_to;
  return draft;
}

/** The `caucus_claim` tool. */
export const claimTool: CaucusTool = {
  name: "caucus_claim",
  description:
    "Claim a target — take first-write-wins ownership of a work item or " +
    "hypothesis BEFORE you investigate it (ADR-C5). ALWAYS read the channel " +
    "first (caucus_read_channel) so you don't duplicate a teammate's claim. " +
    "Returns outcome=granted when you win; outcome=already_claimed with the " +
    "current holder ({agent_id, owner}) when someone got there first — that " +
    "is NOT a failure: build on their work or claim different work, don't " +
    "re-investigate. The granted claim is posted to the channel so everyone " +
    "sees who owns what. Put scope in `note`; never include secrets (ADR-C12).",
  inputSchema: CLAIM_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const claimArgs = args as unknown as ClaimArgs;
    const draft = buildClaimDraft(claimArgs);
    // `channel` is a routing target threaded SEPARATELY from the draft (CAU-92):
    // it is not part of the claim. Both outcomes are normal results — neither is
    // `isError`. Errors (empty target, unknown channel, or a not-joined cross-
    // room target → value-free NotJoinedError) propagate untouched; the
    // backbone's and the gate's messages are value-free (ADR-C12), so nothing
    // here interpolates target/note/channel.
    const result = await session.claim(draft, claimArgs.channel);
    if (result.outcome === "granted") {
      const payload = {
        outcome: "granted",
        msg_id: result.message.msg_id,
        cursor: result.cursor,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
    // `already_claimed.by` carries the winner's identity straight into this
    // (losing) agent's model context. The free-form identity fields are
    // poster-controlled, so sanitize them BEFORE serialization (CAU-73), the
    // same defense read_channel applies. `ts`/`msg_id` are validated formats and
    // left untouched.
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
