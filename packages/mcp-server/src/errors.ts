/**
 * MCP-server error taxonomy (CAU-92).
 *
 * Errors the server raises *above* the backbone — i.e. for policy the backbone
 * does not own. Today that is one error: the cross-room posting join-gate
 * (CAU-92). The backbone has its own taxonomy (`@caucus/backbone` `errors.ts`)
 * and the schema another (`@caucus/schema`); this module is for failures that
 * belong to the session/tool layer.
 *
 * Like every error that can reach a `handle()` and be echoed into the
 * channel-visible result (see `tools/registry.ts`), these messages are
 * VALUE-FREE (ADR-C12): they never interpolate a channel name, body, target, or
 * any other caller content — only a fixed, actionable instruction the model can
 * recover from.
 */

/**
 * Thrown by {@link import("./session.js").CaucusSession.post}/`claim` when a
 * write names a `target` channel the session has not joined (CAU-92).
 *
 * The cross-room posting join-gate (ADR-C6 addendum): a session may post into a
 * room other than its home `CAUCUS_CHANNEL` only after deliberately joining it
 * with `caucus_join_channel`. This error names NEITHER the rejected channel nor
 * any caller content — interpolating the target would defeat the value-free
 * discipline the backbone's errors hold to (ADR-C12), and the actionable
 * instruction ("join it first") is enough for the model to recover.
 */
export class NotJoinedError extends Error {
  /** Stable, machine-readable error class. */
  readonly code = "not_joined";

  constructor() {
    super(
      "Cannot post to that channel: it has not been joined in this session. " +
        "Join it first with caucus_join_channel, then retry.",
    );
    this.name = "NotJoinedError";
  }
}
