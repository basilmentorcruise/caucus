/**
 * Identity stamping — the single choke point through which the session's
 * agent→human identity is welded onto every outgoing message (CAU-9, ADR-C7).
 *
 * Tools author a {@link ToolMessageDraft}: a message *without* `agent_id`,
 * `owner`, or `msg_id`. {@link stampIdentity} is the only place those fields are
 * set. Defence is twofold:
 *
 * - **Type level:** `ToolMessageDraft` omits the identity fields, so a tool
 *   cannot even name them.
 * - **Runtime level:** the identity is spread *after* the draft, so even a draft
 *   force-cast with forged `agent_id`/`owner` is overwritten, never trusted.
 *
 * Server-side *anchoring* of that identity (proving the agent really is who it
 * claims) is CAU-13's job; this module guarantees only that whatever identity
 * the session resolved is the identity every message carries.
 */
import type { MessageInput } from "@caucus/schema";
import { newMsgId } from "@caucus/schema";
import type { SessionIdentity } from "./config.js";

/**
 * A message as authored by a tool: everything in {@link MessageInput} except the
 * server-owned identity (`agent_id`, `owner`) and the freshly-minted `msg_id`.
 * Tools never supply these — {@link stampIdentity} does.
 */
export type ToolMessageDraft = Omit<
  MessageInput,
  "agent_id" | "owner" | "msg_id"
>;

/**
 * Weld the session identity and a fresh ULID `msg_id` onto a draft, producing a
 * complete {@link MessageInput} ready for the backbone.
 *
 * The identity is spread last so it always wins over anything already on the
 * draft — there is no way for a caller to inject a different `agent_id`/`owner`.
 */
export function stampIdentity(
  identity: SessionIdentity,
  draft: ToolMessageDraft,
): MessageInput {
  return {
    ...draft,
    agent_id: identity.agent_id,
    owner: identity.owner,
    msg_id: newMsgId(),
  } as MessageInput;
}
