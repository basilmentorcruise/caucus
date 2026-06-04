/**
 * `caucus_status` — a read-only diagnostic tool (CAU-9).
 *
 * Reports the session's resolved identity (agent_id, owner) and channel, plus a
 * best-effort snapshot of the channel head. It exists so a freshly-connected
 * Claude Code session can confirm *who it is acting as* and *where* before doing
 * anything else.
 *
 * Two invariants it must never break:
 * - **ADR-C6 (quiet by default):** it posts NOTHING — it only reads.
 * - **ADR-C12 (secret hygiene):** it exposes NO token or secret, only the
 *   already-resolved identity.
 */
import { UnknownChannelError } from "@caucus/backbone";
import type { CaucusSession } from "../session.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** The shape of the JSON `caucus_status` reports. */
interface StatusReport {
  readonly agent_id: string;
  readonly owner: string;
  readonly channel: string;
  /** Current channel head, or `null` if the channel does not exist yet. */
  readonly head: number | null;
}

/**
 * The `caucus_status` tool. Takes no arguments; returns the session identity and
 * channel, tolerating an as-yet-uncreated channel (head reported as `null`).
 */
export const statusTool: CaucusTool = {
  name: "caucus_status",
  description:
    "Report this Caucus session's identity (agent_id, owner) and channel. " +
    "Read-only: posts nothing and reveals no secrets.",
  inputSchema: {},
  async handle(session: CaucusSession): Promise<ToolResult> {
    let head: number | null = null;
    try {
      const descriptor = await session.reader.describeChannel(
        session.channel,
      );
      head = descriptor.head;
    } catch (err) {
      // A not-yet-created channel is not an error for a diagnostic; report
      // head: null. Any other failure is unexpected and should surface.
      if (!(err instanceof UnknownChannelError)) {
        throw err;
      }
    }

    const report: StatusReport = {
      agent_id: session.identity.agent_id,
      owner: session.identity.owner,
      channel: session.channel,
      head,
    };

    return {
      content: [{ type: "text", text: JSON.stringify(report) }],
    };
  },
};
