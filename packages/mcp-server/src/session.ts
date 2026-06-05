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
 * {@link CaucusSession.post}, {@link CaucusSession.claim}, and {@link
 * CaucusSession.createChannel} are the ONLY write paths, and this is enforced by
 * the type system, not by convention: the full {@link Backbone} (with
 * `append`/`claim`/`createChannel`) is captured in a closure inside {@link
 * createSession} and is NOT reachable from anything a tool holds. The only
 * backbone surface a tool can touch is {@link CaucusSession.reader}, a read-only
 * {@link BackboneReader} — so a tool cannot append a message with a forged
 * identity by going around `stampIdentity`, nor create a channel with a forged
 * `created_by` by going around the session (the session anchors it to
 * `identity.owner`).
 *
 * Routing is deliberate: `post` goes to `append` (which rejects claim-typed
 * messages) and `claim` goes to `claim` (the only path that writes the claim
 * ledger) — see the backbone contract (ADR-C5).
 */
import type {
  AppendResult,
  Backbone,
  ChannelDescriptor,
  ClaimResult,
} from "@caucus/backbone";
import type { SessionIdentity, ServerConfig } from "./config.js";
import { stampIdentity, type ToolMessageDraft } from "./identity.js";

/**
 * The read-only slice of {@link Backbone} a session exposes to tools.
 *
 * This is deliberately a `Pick` of only the non-mutating methods: a tool can
 * read the log and inspect channels, but the write paths (`append`, `claim`,
 * `createChannel`) are absent from the type, so there is no way for a tool to
 * append a message that bypasses {@link CaucusSession.post}/`claim` and the
 * identity stamping they perform (ADR-C7, AC2).
 */
export type BackboneReader = Pick<
  Backbone,
  "readSince" | "subscribe" | "describeChannel" | "listChannels"
>;

/**
 * What a tool may supply when creating a channel through the session.
 *
 * Deliberately the {@link import("@caucus/backbone").CreateChannelOptions}
 * MINUS `created_by`: the owner is server-anchored from the session identity,
 * so a tool (and the model behind it) cannot forge attribution by passing a
 * `created_by` of its choosing — the same write-path firewall that protects
 * {@link CaucusSession.post}/{@link CaucusSession.claim} (ADR-C7).
 */
export interface SessionCreateChannelOptions {
  /** Desired channel name; the backbone validates it against the slug rule. */
  readonly channel: string;
  /** What this channel is for. Stored verbatim on the descriptor. No secrets. */
  readonly purpose: string;
}

/** The tool-facing session surface. */
export interface CaucusSession {
  /** The agent→human identity stamped on everything this session emits. */
  readonly identity: SessionIdentity;
  /** The channel this session is bound to. */
  readonly channel: string;
  /**
   * Read-only view of the backbone for diagnostics (e.g. channel head).
   *
   * This is a {@link BackboneReader}, NOT the full {@link Backbone}: the write
   * methods are not on this type, so a tool cannot reach `append`/`claim`/
   * `createChannel` and forge identity. {@link post}/{@link claim} are the only
   * write paths.
   */
  readonly reader: BackboneReader;

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

  /**
   * Create a new ephemeral channel, attributed to this session's owner.
   *
   * This is a SANCTIONED write — like {@link post}/{@link claim} — and lives on
   * the session, NOT on {@link reader}: `createChannel` is deliberately absent
   * from {@link BackboneReader} so a tool cannot reach the raw backbone's create
   * path and supply a forged `created_by`. The session anchors `created_by` to
   * {@link identity}.owner server-side; the caller supplies only `channel` and
   * `purpose` (see {@link SessionCreateChannelOptions}).
   *
   * @throws InvalidChannelNameError if `channel` is not a valid slug.
   * @throws ChannelExistsError if a channel with that name already exists.
   */
  createChannel(opts: SessionCreateChannelOptions): Promise<ChannelDescriptor>;
}

/**
 * Build a {@link CaucusSession} from resolved config and a backbone.
 *
 * The full {@link Backbone} stays captured in this closure: only {@link
 * CaucusSession.post}/{@link CaucusSession.claim} can write, and the exposed
 * {@link CaucusSession.reader} is narrowed to {@link BackboneReader} so tools
 * cannot bypass identity stamping.
 */
export function createSession(
  config: ServerConfig,
  backbone: Backbone,
): CaucusSession {
  const { identity, channel } = config;
  // Delegating wrapper, not the backbone reference itself: the narrowing must
  // hold at RUNTIME too — a tool that casts the reader still finds no
  // append/claim/createChannel on it.
  const reader: BackboneReader = {
    readSince: (ch, cursor, limit) => backbone.readSince(ch, cursor, limit),
    subscribe: (ch) => backbone.subscribe(ch),
    describeChannel: (ch) => backbone.describeChannel(ch),
    listChannels: () => backbone.listChannels(),
  };
  return {
    identity,
    channel,
    reader,
    post(draft) {
      return backbone.append(channel, stampIdentity(identity, draft));
    },
    claim(draft) {
      return backbone.claim(channel, stampIdentity(identity, draft));
    },
    createChannel({ channel: name, purpose }) {
      // `created_by` is server-anchored from the session identity — the caller
      // never supplies it, so attribution can't be forged (ADR-C7). This goes
      // through the closed-over backbone, the only `createChannel` a session can
      // reach; it is intentionally NOT on `reader`.
      return backbone.createChannel({
        channel: name,
        purpose,
        created_by: identity.owner,
      });
    },
  };
}
