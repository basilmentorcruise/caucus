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
 *
 * Cross-room posting (CAU-92): `post`/`claim` take an optional `target` channel
 * — a per-call override, NOT a stateful re-bind, so the session's HOME channel
 * never changes (the out-of-process hook, `caucus_status`, and
 * `caucus_subscribe` keep following home). `target` is a ROUTING string a tool
 * may NAME; it does not widen what a tool can reach (the full backbone stays
 * closed-over, the write-path firewall intact). A `target` other than home is
 * gated: the session keeps a process-local `joinedChannels` set (opened only by
 * {@link CaucusSession.noteJoined}, called by `caucus_join_channel`) and
 * REJECTS — inside `post`/`claim`, before the backbone is touched — any target
 * not in `joinedChannels ∪ {home}`. The gate lives here, not in a tool handler,
 * so no tool can bypass it (ADR-C6 addendum / ADR-C12).
 */
import type {
  AppendResult,
  Backbone,
  ChannelDescriptor,
  ClaimResult,
} from "@caucus/backbone";
import type { SessionIdentity, ServerConfig } from "./config.js";
import { stampIdentity, type ToolMessageDraft } from "./identity.js";
import { NotJoinedError } from "./errors.js";

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
   * Stamp identity onto `draft` and append it to a channel. Use this for every
   * non-claim message; routing a `claim`-typed draft here is rejected by the
   * backbone (claims must go through {@link claim}).
   *
   * `target` (CAU-92) routes the write to a channel OTHER than home — a per-call
   * override, not a re-bind. Absent (or equal to home) ⇒ home, byte-identical to
   * before. A `target` other than home MUST have been joined via {@link
   * noteJoined} (i.e. `caucus_join_channel`) or this throws {@link
   * NotJoinedError} BEFORE touching the backbone — the gate is enforced here, not
   * in the tool handler, so it cannot be bypassed. Identity is stamped
   * server-side regardless of `target`.
   *
   * @throws NotJoinedError if `target` is a non-home channel not yet joined.
   */
  post(draft: ToolMessageDraft, target?: string): Promise<AppendResult>;

  /**
   * Stamp identity onto a `claim`-typed `draft` and run it through the claim
   * ledger (first-write-wins). Returns the granted/already-claimed outcome.
   *
   * `target` (CAU-92) routes the claim to a channel OTHER than home; the
   * join-gate and identity stamping behave exactly as for {@link post}. Claim
   * ledgers are per-channel, so a target is independently claimable in home and
   * any joined room.
   *
   * @throws NotJoinedError if `target` is a non-home channel not yet joined.
   */
  claim(draft: ToolMessageDraft, target?: string): Promise<ClaimResult>;

  /**
   * Open the cross-room posting gate for `channel` (CAU-92).
   *
   * Called by `caucus_join_channel` AFTER a successful subscribe, so a
   * deliberate join — not a bare read — is what authorizes posting into a room.
   * Idempotent; adding the home channel is harmless (it is always allowed). This
   * is the ONLY way to widen the set {@link post}/{@link claim} validate against,
   * keeping the gate process-local and unforgeable by a tool.
   */
  noteJoined(channel: string): void;

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
  // Process-local cross-room posting gate (CAU-92). Closed over in this scope
  // alongside `backbone` — NOT reachable by a tool except via `noteJoined`
  // (open) and the validation inside `post`/`claim` (check). The home channel is
  // always allowed and is NOT stored here; it is unioned in at check time.
  const joinedChannels = new Set<string>();
  // Resolve a write's target channel and enforce the join-gate. A target equal
  // to home (or absent) is always allowed; any other target must have been
  // joined. Throws BEFORE the backbone is touched, so a rejected cross-post
  // leaves the target channel's head unchanged (AC3). The error is value-free
  // (ADR-C12) — it names neither the target nor any caller content.
  const resolveTarget = (target?: string): string => {
    const ch = target ?? channel;
    if (ch !== channel && !joinedChannels.has(ch)) {
      throw new NotJoinedError();
    }
    return ch;
  };
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
    noteJoined(joined) {
      joinedChannels.add(joined);
    },
    // `async` so a closed-gate `resolveTarget` throw surfaces as a REJECTED
    // promise (uniform with the backbone's own async rejections), not a
    // synchronous throw — callers always `await` these and may rely on `.catch`.
    async post(draft, target) {
      // resolveTarget enforces the join-gate first; identity is stamped
      // server-side regardless of the target (a forged identity can't ride a
      // cross-post any more than a home post).
      const ch = resolveTarget(target);
      return backbone.append(ch, stampIdentity(identity, draft));
    },
    async claim(draft, target) {
      const ch = resolveTarget(target);
      return backbone.claim(ch, stampIdentity(identity, draft));
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
