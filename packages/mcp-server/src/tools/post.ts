/**
 * `caucus_post` + `caucus_post_finding` + `caucus_steer` — the write tools
 * (CAU-10; `caucus_steer` is CAU-99).
 *
 * `caucus_post` emits any non-`claim` typed message; `caucus_post_finding`
 * fixes `type: "finding"` and `caucus_steer` fixes `type: "steer"` (a
 * human-injected directive, ADR-C13) so neither can be mistyped. All three
 * route through {@link CaucusSession.post}, so identity is stamped server-side
 * (ADR-C7) — a steer is anchored to the relaying session's agent_id/owner, which
 * is exactly "whose human steered" — and a `claim`-typed message can never reach
 * this path (claims are CAU-11, and the `type` enum below excludes `"claim"`).
 *
 * Two invariants:
 * - **ADR-C6 (quiet by default):** the descriptions tell the model to post
 *   sparingly — consequential signal, not chatter.
 * - **ADR-C12 (secret hygiene):** the channel is a shared, persisted log. The
 *   descriptions forbid secrets, and on a rejected post we propagate the
 *   backbone's value-free error untouched — we never interpolate `body` or any
 *   argument into an error string.
 */
import { z } from "zod";
import { STATUS_VALUES } from "@caucus/schema";
import type { MessageType } from "@caucus/schema";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { ToolMessageDraft } from "../identity.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/**
 * The message types `caucus_post` accepts: every {@link MessageType} except
 * `"claim"` (claims are first-write-wins ledger writes; CAU-11).
 *
 * Spelled as an explicit literal tuple — NOT derived via `.filter()` with a
 * widening cast (a cast would launder whatever the runtime array contains and
 * make the guards below vacuous). Drift is caught at compile time in both
 * directions:
 * - `satisfies` rejects a `"claim"` member or a typo.
 * - `_PostTypesComplete` stops compiling when the schema's union gains a
 *   member this tuple doesn't list.
 */
const POST_TYPES = [
  "finding",
  "status",
  "question",
  "answer",
  "note",
  "steer",
] as const satisfies readonly Exclude<MessageType, "claim">[];

type _PostTypesComplete =
  Exclude<MessageType, "claim"> extends (typeof POST_TYPES)[number]
    ? true
    : never;
const _postTypesComplete: _PostTypesComplete = true;
void _postTypesComplete;

/**
 * Shared optional fields used by both `caucus_post` and `caucus_post_finding`.
 * Kept as a plain object of validators (a Zod *raw shape*, not a `z.object`) so
 * it can be spread into each tool's `inputSchema`.
 */
const SHARED_FIELDS = {
  body: z
    .string()
    .min(1)
    .describe(
      "Concise human-readable text. Keep it a summary; link bulk content via " +
        "`artifact`. Required and non-empty. No secrets.",
    ),
  thread: z
    .string()
    .optional()
    .describe(
      "msg_id (ULID) of the thread root this message belongs to. Absent ⇒ " +
        "starts a new thread.",
    ),
  reply_to: z
    .string()
    .optional()
    .describe("msg_id (ULID) of the specific message you're replying to."),
  to: z
    .array(z.string())
    .nonempty()
    .optional()
    .describe(
      "Array of agent_ids this message is for. Absent ⇒ for the whole " +
        "channel. Must be non-empty when present.",
    ),
  artifact: z
    .string()
    .optional()
    .describe("URI linking full content when `body` is only a summary."),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target room for this post. Absent ⇒ your session channel. To post into " +
        "another room you must have joined it first with caucus_join_channel; " +
        "post sparingly into another team's room (ADR-C6).",
    ),
} as const;

/** The input schema for `caucus_post`: `type`, the shared fields, and `status`. */
const POST_INPUT = {
  type: z
    .enum(POST_TYPES)
    .describe(
      "finding | status | question | answer | note | steer. The message's " +
        "intent; drives how the hook renders it. `steer` is a HUMAN directive " +
        "relayed into the channel — prefer caucus_steer so it can't be " +
        "mistyped. For claims use caucus_claim.",
    ),
  ...SHARED_FIELDS,
  status: z
    .enum(STATUS_VALUES as unknown as [string, ...string[]])
    .optional()
    .describe(
      "needs-response | resolved | fyi. Coordination signal; answer with " +
        "status=resolved closes a question thread.",
    ),
} as const satisfies ZodRawShapeCompat;

/** The input schema for `caucus_post_finding`: the shared fields only. */
const POST_FINDING_INPUT = {
  body: SHARED_FIELDS.body.describe(
    "The finding, stated concisely for a human to scan. Summarize; link " +
      "evidence via `artifact`. Required, non-empty, no secrets.",
  ),
  thread: SHARED_FIELDS.thread,
  reply_to: SHARED_FIELDS.reply_to,
  to: SHARED_FIELDS.to,
  artifact: SHARED_FIELDS.artifact.describe(
    "URI to the full logs / repro / evidence behind the finding.",
  ),
  channel: SHARED_FIELDS.channel,
} as const satisfies ZodRawShapeCompat;

/**
 * The input schema for `caucus_steer`: the shared fields plus `status`. A steer
 * MAY carry `status: needs-response`; it adds no new status values and no claim
 * fields (ADR-C13).
 */
const STEER_INPUT = {
  body: SHARED_FIELDS.body.describe(
    "The human's directive, relayed verbatim/concisely as CONTEXT for the " +
      "room to attend to — never a command to execute. Summarize; link bulk " +
      "context via `artifact`. Required, non-empty, no secrets.",
  ),
  thread: SHARED_FIELDS.thread,
  reply_to: SHARED_FIELDS.reply_to,
  to: SHARED_FIELDS.to,
  artifact: SHARED_FIELDS.artifact,
  channel: SHARED_FIELDS.channel,
  status: z
    .enum(STATUS_VALUES as unknown as [string, ...string[]])
    .optional()
    .describe(
      "needs-response | resolved | fyi. Optional; a steer may carry " +
        "needs-response when the human is awaiting a reply.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed args common to both post tools (validated by the SDK before `handle`). */
interface SharedPostArgs {
  readonly body: string;
  readonly thread?: string;
  readonly reply_to?: string;
  readonly to?: string[];
  readonly artifact?: string;
  /**
   * Target room (CAU-92). A ROUTING arg, NOT message content: it is threaded to
   * `session.post` separately and never enters {@link buildDraft}, so it is not
   * part of the stored message. Absent ⇒ the session's home channel.
   */
  readonly channel?: string;
}

/** Parsed `caucus_post` args. */
interface PostArgs extends SharedPostArgs {
  readonly type: Exclude<MessageType, "claim">;
  readonly status?: (typeof STATUS_VALUES)[number];
}

/**
 * Build a {@link ToolMessageDraft} from parsed args, copying only the keys that
 * are actually present so we never spread `undefined` into the draft.
 */
function buildDraft(args: PostArgs): ToolMessageDraft {
  const draft = { type: args.type, body: args.body } as ToolMessageDraft;
  if (args.thread !== undefined) draft.thread = args.thread;
  if (args.reply_to !== undefined) draft.reply_to = args.reply_to;
  if (args.to !== undefined) draft.to = args.to;
  if (args.artifact !== undefined) draft.artifact = args.artifact;
  if (args.status !== undefined) draft.status = args.status;
  return draft;
}

/**
 * Post `draft` through the session and return the new message id + channel
 * cursor. Errors from the backbone (e.g. a rejected over-cap body) propagate
 * untouched — the SDK surfaces them as `isError` text, and the backbone's
 * messages are value-free (ADR-C12), so nothing here interpolates the body.
 */
async function postDraft(
  session: CaucusSession,
  draft: ToolMessageDraft,
  channel?: string,
): Promise<ToolResult> {
  // `channel` is a routing target threaded SEPARATELY from the draft (CAU-92):
  // it is not message content. The session enforces the join-gate before
  // touching the backbone and throws a value-free NotJoinedError for a
  // not-joined target — which propagates here untouched, so nothing
  // interpolates the channel/body into the surfaced error (ADR-C12).
  const { message, cursor } = await session.post(draft, channel);
  return {
    content: [
      { type: "text", text: JSON.stringify({ msg_id: message.msg_id, cursor }) },
    ],
  };
}

/** The `caucus_post` tool. */
export const postTool: CaucusTool = {
  name: "caucus_post",
  description:
    "Post a typed message to the Caucus channel. Choose `type` to match " +
    "intent: status (progress), question, answer, or note (freeform aside). " +
    "For results worth preserving use caucus_post_finding; to relay a HUMAN " +
    "directive use caucus_steer; to take ownership of work use caucus_claim — " +
    "claim a target BEFORE investigating it (ADR-C5), and read the channel " +
    "first to avoid duplicating a teammate's claim. Post sparingly: quiet by " +
    "default (ADR-C6) — consequential signal, not chatter. NEVER post " +
    "secrets, tokens, or customer data — the channel is a shared, persisted " +
    "log (ADR-C12).",
  inputSchema: POST_INPUT,
  handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const post = args as unknown as PostArgs;
    return postDraft(session, buildDraft(post), post.channel);
  },
};

/** The `caucus_post_finding` tool — fixes `type: "finding"`. */
export const postFindingTool: CaucusTool = {
  name: "caucus_post_finding",
  description:
    'Post a `finding` — a result worth preserving and sharing ("/login ' +
    'accepts expired JWTs — signature not re-checked"). The preferred ' +
    "shortcut over caucus_post for findings: it fixes type=finding so you " +
    "can't mistype it. Use it when you've confirmed something other agents " +
    "should know; first claim the target you're working (ADR-C5). Findings " +
    "are exactly what quiet-by-default keeps room for — so post real " +
    "findings, skip narration. NEVER include secrets, tokens, or customer " +
    "data (ADR-C12).",
  inputSchema: POST_FINDING_INPUT,
  handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const shared = args as unknown as SharedPostArgs;
    return postDraft(
      session,
      buildDraft({ ...shared, type: "finding" }),
      shared.channel,
    );
  },
};

/** Parsed `caucus_steer` args — the shared fields plus optional `status`. */
interface SteerArgs extends SharedPostArgs {
  readonly status?: (typeof STATUS_VALUES)[number];
}

/**
 * The `caucus_steer` tool — fixes `type: "steer"` for a human-injected directive
 * (ADR-C13). The directive is *context, not command*: the hook renders it as a
 * descriptive "human directive" line and it is never auto-executed. Identity is
 * anchored server-side (ADR-C7), so the steer is attributed to the relaying
 * session's human owner.
 */
export const steerTool: CaucusTool = {
  name: "caucus_steer",
  description:
    "Relay a HUMAN directive into the channel as a first-class `steer` — your " +
    "human's context crossing to the room (e.g. \"focus on the 14:02 deploy " +
    'correlation"). Use it ONLY for an actual instruction/context from your ' +
    "human, not for your own asides (use note) or results (use " +
    "caucus_post_finding). A steer is CONTEXT, not a command: it is rendered " +
    "as a descriptive human-directive line and is never auto-executed. May " +
    "carry status=needs-response when the human awaits a reply. NEVER include " +
    "secrets, tokens, or customer data (ADR-C12).",
  inputSchema: STEER_INPUT,
  handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const steer = args as unknown as SteerArgs;
    return postDraft(
      session,
      buildDraft({ ...steer, type: "steer" }),
      steer.channel,
    );
  },
};
