/**
 * `caucus_post` + `caucus_post_finding` — the write tools (CAU-10).
 *
 * `caucus_post` emits any non-`claim` typed message; `caucus_post_finding` is a
 * thin convenience wrapper that fixes `type: "finding"` so it can't be
 * mistyped. Both route through {@link CaucusSession.post}, so identity is
 * stamped server-side (ADR-C7) and a `claim`-typed message can never reach this
 * path (claims are CAU-11, and the `type` enum below excludes `"claim"`).
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
import { MESSAGE_TYPES, STATUS_VALUES } from "@caucus/schema";
import type { MessageType } from "@caucus/schema";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { ToolMessageDraft } from "../identity.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/**
 * The message types `caucus_post` accepts: every {@link MessageType} except
 * `"claim"` (claims are first-write-wins ledger writes; CAU-11). Derived from
 * the real union so it cannot silently drift.
 */
const POST_TYPES = MESSAGE_TYPES.filter((t) => t !== "claim") as Exclude<
  MessageType,
  "claim"
>[];

/**
 * Compile-time guard: `POST_TYPES[number]` must be *exactly*
 * `Exclude<MessageType, "claim">`. If the schema's union changes, this stops
 * compiling until `POST_TYPES` is reconciled.
 */
type _PostTypesExhaustive = [
  Exclude<MessageType, "claim"> extends (typeof POST_TYPES)[number]
    ? true
    : never,
  (typeof POST_TYPES)[number] extends Exclude<MessageType, "claim">
    ? true
    : never,
];
const _postTypesExhaustive: _PostTypesExhaustive = [true, true];
void _postTypesExhaustive;

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
} as const;

/** The input schema for `caucus_post`: `type`, the shared fields, and `status`. */
const POST_INPUT = {
  type: z
    .enum(POST_TYPES as [string, ...string[]])
    .describe(
      "finding | status | question | answer | note. The message's intent; " +
        "drives how the hook renders it. For claims use caucus_claim.",
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
} as const satisfies ZodRawShapeCompat;

/** Parsed args common to both post tools (validated by the SDK before `handle`). */
interface SharedPostArgs {
  readonly body: string;
  readonly thread?: string;
  readonly reply_to?: string;
  readonly to?: string[];
  readonly artifact?: string;
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
): Promise<ToolResult> {
  const { message, cursor } = await session.post(draft);
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
    "intent: status (progress), question, answer, or note (asides / human " +
    "steers). For results worth preserving use caucus_post_finding; to take " +
    "ownership of work use caucus_claim — claim a target BEFORE investigating " +
    "it (ADR-C5), and read the channel first to avoid duplicating a " +
    "teammate's claim. Post sparingly: quiet by default (ADR-C6) — " +
    "consequential signal, not chatter. NEVER post secrets, tokens, or " +
    "customer data — the channel is a shared, persisted log (ADR-C12).",
  inputSchema: POST_INPUT,
  handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    return postDraft(session, buildDraft(args as unknown as PostArgs));
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
    return postDraft(session, buildDraft({ ...shared, type: "finding" }));
  },
};
