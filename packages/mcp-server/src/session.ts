/**
 * The per-connection session (CAU-9).
 *
 * A {@link CaucusSession} binds the resolved identity + channel to a backbone
 * and is the *only* surface tools use to emit messages. Tools never construct a
 * `MessageInput`, never see the identity fields, and never touch
 * `backbone.append`/`backbone.claim` directly — they call {@link
 * CaucusSession.post} / {@link CaucusSession.claim} with an identity-free draft,
 * and the session stamps identity (see `identity.ts`) before delegating.
 *
 * Routing is deliberate: `post` goes to `append` (which rejects claim-typed
 * messages) and `claim` goes to `claim` (the only path that writes the claim
 * ledger) — see the backbone contract (ADR-C5).
 */
import type {
  AppendResult,
  Backbone,
  ClaimResult,
} from "@caucus/backbone";
import type { SessionIdentity, ServerConfig } from "./config.js";
import { stampIdentity, type ToolMessageDraft } from "./identity.js";

/** The tool-facing session surface. */
export interface CaucusSession {
  /** The agent→human identity stamped on everything this session emits. */
  readonly identity: SessionIdentity;
  /** The channel this session is bound to. */
  readonly channel: string;
  /** The backbone this session writes to (exposed for read-only diagnostics). */
  readonly backbone: Backbone;

  /**
   * Stamp identity onto `draft` and append it to the session channel. Use this
   * for every non-claim message; routing a `claim`-typed draft here is rejected
   * by the backbone (claims must go through {@link claim}).
   */
  post(draft: ToolMessageDraft): Promise<AppendResult>;

  /**
   * Stamp identity onto a `claim`-typed `draft` and run it through the claim
   * ledger (first-write-wins). Returns the granted/already-claimed outcome.
   */
  claim(draft: ToolMessageDraft): Promise<ClaimResult>;
}

/** Build a {@link CaucusSession} from resolved config and a backbone. */
export function createSession(
  config: ServerConfig,
  backbone: Backbone,
): CaucusSession {
  const { identity, channel } = config;
  return {
    identity,
    channel,
    backbone,
    post(draft) {
      return backbone.append(channel, stampIdentity(identity, draft));
    },
    claim(draft) {
      return backbone.claim(channel, stampIdentity(identity, draft));
    },
  };
}
