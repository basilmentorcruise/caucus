/**
 * `caucus_catch_me_up` digest projection (CAU-19) — PURE, no I/O.
 *
 * A digest is a DETERMINISTIC, structured projection of the typed log over a
 * cursor window. There is no model call here (and none in the tool): the
 * scoping decision (see issue #19) is that the requesting agent's OWN Claude
 * Code session narrates the projection into prose if a human wants prose. The
 * server stays the LLM-free substrate (ADR-C2) and never holds a provider key
 * (ADR-C12). This module computes counts/groupings/open claims/unanswered
 * questions/key findings from already-stored, already-typed messages, and
 * renders the SAME structured object to a copy-pasteable postmortem-skeleton
 * markdown. It contributes NO new message type, field, or schema-version bump.
 *
 * INTENTIONAL SANITIZATION ASYMMETRY (ADR-C12). Poster-controlled text is
 * untrusted on every render surface, but the two surfaces need different
 * treatment:
 *
 *  - {@link buildDigest} produces the structured JSON. It one-lines + control-
 *    strips every poster-controlled body it embeds (via {@link oneLine}), which
 *    also forms the base text the markdown render reuses. The structured output
 *    stays "raw but control-stripped": NO markdown escaping, because JSON is not
 *    a markdown surface — `JSON.stringify` neutralizes C0/ESC and we strip C1
 *    (the byte `JSON.stringify` passes through), so the structured object cannot
 *    smuggle a terminal/C1 escape, and a `#`/`[` in a body is just data there.
 *  - {@link renderDigestMarkdown} renders that SAME object into markdown. Here a
 *    raw `#`/`*`/`[`/`|`/`>` IS active syntax, so this layer ADDITIONALLY
 *    {@link mdInert}-escapes EVERY poster-controlled fragment it embeds — body,
 *    owner, claim target, and holder/resolver identities — so a poster cannot
 *    forge a heading, a link, a table, or a blockquote in a pasted postmortem.
 *
 * Determinism (B7): a single forward pass in append order, msg_id tiebreaks, and
 * fixed-key records — never Map-iteration order or a locale sort over untrusted
 * strings. The same window over the same log yields byte-identical JSON.
 */
import {
  MESSAGE_TYPES,
  normalizeTarget,
  stripControlChars,
  stripControlCharsKeepWhitespace,
  type MessageType,
} from "@caucus/schema";
import type { AppendedMessage } from "@caucus/backbone";

/**
 * Character cap for a one-lined body embedded in a digest. Bodies are a render
 * surface: a digest is for scanning, so an over-long body is truncated with a
 * `…` marker rather than blowing the catch-up budget.
 */
export const DIGEST_BODY_CHARS = 280 as const;

/**
 * Max `key_findings` returned in append order; older findings beyond this are
 * collapsed into {@link DigestStructured.findings_overflow} so the digest stays
 * scannable and points the reader at `caucus_read_channel` for the full scroll.
 */
export const KEY_FINDINGS_CAP = 20 as const;

/** `window`: the cursor span this digest covers and how many messages it saw. */
export interface DigestWindow {
  /** Cursor the window opened at (the caller's `since`, or 0 from the start). */
  readonly from_cursor: number;
  /** Cursor at the end of the window — pass back as `since` to resume. */
  readonly to_cursor: number;
  /** Count of messages in `[from_cursor, to_cursor)`. */
  readonly message_count: number;
}

/** One participant grouping: a human owner (ADR-C7) and the sessions they posted as. */
export interface DigestParticipant {
  /** The human the agent acts for (one-lined). Grouping key is the RAW owner. */
  readonly owner: string;
  /** How many messages this owner posted in the window. */
  readonly message_count: number;
  /** Unique agent_ids this owner posted as, in first-appearance order (one-lined). */
  readonly agent_ids: readonly string[];
}

/** The holder/resolver of a claim, as derived from the visible `claim` messages. */
export interface ClaimActor {
  /** The human holding/resolving (one-lined). */
  readonly owner: string;
  /** The session that authored the latest claim message (one-lined). */
  readonly agent_id: string;
  /** Opaque ordering token of the latest claim message for this target. */
  readonly ts: string;
}

/** An open claim: a target whose latest claim message leaves it live. */
export interface OpenClaim {
  /** The claimed work item / hypothesis (one-lined; raw target, NOT the ledger key). */
  readonly target: string;
  /** The current holder. */
  readonly holder: ClaimActor;
}

/** A resolved claim: a target whose latest claim message was `status:"resolved"`. */
export interface ResolvedClaim {
  /** The resolved work item / hypothesis (one-lined). */
  readonly target: string;
  /** Who resolved it (the author of the resolving claim message). */
  readonly resolved_by: ClaimActor;
}

/** A question with no resolving answer in the window. */
export interface UnansweredQuestion {
  /** ULID of the question message. */
  readonly msg_id: string;
  /** The asker (one-lined). */
  readonly owner: string;
  /** The question text (one-lined + truncated). */
  readonly body: string;
  /** Opaque ordering token of the question message. */
  readonly ts: string;
}

/** A finding in the timeline. */
export interface KeyFinding {
  /** ULID of the finding message. */
  readonly msg_id: string;
  /** The reporter (one-lined). */
  readonly owner: string;
  /** The finding text (one-lined + truncated). */
  readonly body: string;
  /** Whether the finding carries a non-empty `artifact` link. */
  readonly has_artifact: boolean;
  /** Opaque ordering token of the finding message. */
  readonly ts: string;
}

/** Count per message type. A FIXED-key record (every type, zero-filled). */
export type ByType = Readonly<Record<MessageType, number>>;

/** The deterministic structured projection a digest produces. */
export interface DigestStructured {
  readonly window: DigestWindow;
  /** Count per type — ALL types present (zero-filled) for byte-identical JSON. */
  readonly by_type: ByType;
  /** Per-owner grouping, sorted by owner first-appearance in the window. */
  readonly by_participant: readonly DigestParticipant[];
  /** Targets with a live claim (no later `status:"resolved"`). */
  readonly open_claims: readonly OpenClaim[];
  /** Targets whose latest claim message resolved them. */
  readonly resolved_claims: readonly ResolvedClaim[];
  /** Questions with no resolving answer, in append order. */
  readonly unanswered_questions: readonly UnansweredQuestion[];
  /** How many questions in the window were answered (status:"resolved" reply). */
  readonly answered_questions_count: number;
  /** The most recent {@link KEY_FINDINGS_CAP} findings, in APPEND order. */
  readonly key_findings: readonly KeyFinding[];
  /** Findings beyond the cap (older, dropped from `key_findings`). */
  readonly findings_overflow: number;
}

/** Build a fixed-key, zero-filled by-type record so JSON byte-order is stable. */
function zeroByType(): Record<MessageType, number> {
  const counts = {} as Record<MessageType, number>;
  for (const type of MESSAGE_TYPES) counts[type] = 0;
  return counts;
}

/**
 * Collapse a poster-controlled string to a single trimmed line, strip control
 * bytes, and truncate to {@link DIGEST_BODY_CHARS} with a `…` marker.
 *
 * Order matters: collapse `\s+`→single space FIRST (so a multi-line body reads
 * as one scannable line and a `\n`-bridged token pair does not glue), THEN
 * {@link stripControlChars} (C0/DEL/C1 — the C1 bytes `JSON.stringify` would
 * otherwise pass through, CAU-73), THEN bound the length. Stripping after the
 * whitespace-collapse means leftover control bytes vanish without leaving gaps,
 * and the cap counts visible characters.
 */
export function oneLine(s: string): string {
  // 1) collapse runs of any Unicode whitespace (incl. \n/\t/\r) to one space.
  //    Use stripControlCharsKeepWhitespace first so \n/\t survive into the
  //    \s collapse (a body's line breaks become spaces, not deletions).
  const collapsed = stripControlCharsKeepWhitespace(s).replace(/\s+/g, " ").trim();
  // 2) strip any remaining control bytes (e.g. a C1 that is NOT \s).
  const clean = stripControlChars(collapsed);
  // 3) truncate to the cap with an ellipsis marker (itself control-byte-free).
  if (clean.length <= DIGEST_BODY_CHARS) return clean;
  return `${clean.slice(0, DIGEST_BODY_CHARS)}…`;
}

/**
 * Backslash-escape every markdown metacharacter that is active MID-LINE so a
 * poster-controlled fragment embedded in the markdown export cannot forge
 * structure (ADR-C12). Escapes the CommonMark ASCII punctuation that can take
 * effect anywhere in a line — emphasis (`* _`), code (`` ` ``), links/images
 * (`[ ] ( ) !`), headings (`#`), braces (`{ }`), tables (`|`), blockquotes
 * (`>`), and the backslash itself.
 *
 * `+`, `-`, and `.` are DELIBERATELY excluded. They are markdown-structural ONLY
 * at line-start (a bullet `- ` / `+ ` or an ordered-list `1. `): every fragment
 * this function receives is {@link oneLine}d (newline-free) and interpolated
 * MID-LINE, so none of them can ever sit at a line-start. Escaping them bought
 * no injection defense and only littered hyphenated identifiers/versions
 * (`incident-1`, `auth-service`, `v1.2.3`) with `\-`/`\.` in human-pasted
 * postmortems. ALL mid-line-active metacharacters remain escaped: a forged
 * heading (`## `), a link (`](http…)`), emphasis, code, a table, or a blockquote
 * is still neutralized (the C3 vision-guard asserts this).
 *
 * Input is expected to already be {@link oneLine}d (single line, control-byte
 * free): so a forged `\n## Heading` cannot survive (the newline is gone), and
 * this layer additionally neutralizes a leading `## ` or a `](http…)` link on
 * that single line. The backslash is escaped FIRST so the escapes we add are
 * not themselves re-escaped.
 */
export function mdInert(s: string): string {
  return s.replace(/[\\`*_{}[\]()#!|>]/g, "\\$&");
}

/**
 * Internal: the running per-target claim state derived from the log. The LATEST
 * claim message for a target wins, so we overwrite on each `claim` we replay.
 */
interface ClaimState {
  readonly target: string;
  readonly actor: ClaimActor;
  readonly resolved: boolean;
  /** First-appearance index of this target, for stable output ordering. */
  readonly order: number;
}

/**
 * Compute the {@link DigestStructured} projection over a cursor window.
 *
 * `messages` MUST be the window in append order. The claim state is
 * reconstructed FROM THE LOG (the visible `claim`-typed messages), NOT the live
 * ledger: this is a read-side projection and may run over a closed channel, a
 * partial window, or a foreign room the caller only reads. Targets are keyed by
 * {@link normalizeTarget} so the reconstruction matches the ledger's own key.
 */
export function buildDigest(
  messages: readonly AppendedMessage[],
  opts: { from_cursor: number; to_cursor: number },
): DigestStructured {
  const by_type = zeroByType();

  // Participant grouping by RAW owner, first-appearance order (ADR-C7).
  const participantOrder: string[] = [];
  const participants = new Map<
    string,
    { owner: string; count: number; agentIds: string[]; agentSeen: Set<string> }
  >();

  // Claim state per normalized target; latest message wins.
  const claimOrder: string[] = [];
  const claims = new Map<string, ClaimState>();

  // Questions, and the set of question msg_ids that have a resolving answer.
  const questions: { msg_id: string; owner: string; body: string; ts: string }[] =
    [];
  const answeredQuestionIds = new Set<string>();

  // Findings, in append order (capped + overflow computed after the pass).
  const findings: KeyFinding[] = [];

  let nextClaimOrder = 0;

  for (const m of messages) {
    by_type[m.type] += 1;

    // Participant grouping (every type counts toward an owner's tally).
    let p = participants.get(m.owner);
    if (p === undefined) {
      p = { owner: m.owner, count: 0, agentIds: [], agentSeen: new Set() };
      participants.set(m.owner, p);
      participantOrder.push(m.owner);
    }
    p.count += 1;
    if (typeof m.agent_id === "string" && !p.agentSeen.has(m.agent_id)) {
      p.agentSeen.add(m.agent_id);
      p.agentIds.push(m.agent_id);
    }

    switch (m.type) {
      case "claim": {
        // Derive the ledger key the SAME way the backbone does. A target that
        // normalizes empty is malformed for our purposes — skip it (it could
        // not be a real ledger key); never throw on log data.
        let key: string;
        try {
          key = normalizeTarget(m.target);
        } catch {
          break;
        }
        const resolved = m.status === "resolved";
        const existing = claims.get(key);
        const order = existing?.order ?? nextClaimOrder++;
        if (existing === undefined) claimOrder.push(key);
        // Latest claim message wins: a resolve-then-reclaim re-opens the target
        // (the reclaim is the latest and is not resolved); a reassign overwrites
        // the holder; a heartbeat updates ts. We always overwrite with THIS msg.
        claims.set(key, {
          target: m.target,
          actor: {
            owner: m.owner,
            agent_id: typeof m.agent_id === "string" ? m.agent_id : "",
            ts: m.ts,
          },
          resolved,
          order,
        });
        break;
      }
      case "question": {
        questions.push({
          msg_id: m.msg_id,
          owner: m.owner,
          body: m.body,
          ts: m.ts,
        });
        break;
      }
      case "answer": {
        // A question Q is answered iff some answer A with status:"resolved" has
        // thread === Q.msg_id OR reply_to === Q.msg_id (pinned, AC B5). A
        // non-resolved answer does NOT close the question.
        if (m.status === "resolved") {
          if (typeof m.thread === "string") answeredQuestionIds.add(m.thread);
          if (typeof m.reply_to === "string") answeredQuestionIds.add(m.reply_to);
        }
        break;
      }
      case "finding": {
        findings.push({
          msg_id: m.msg_id,
          owner: oneLine(m.owner),
          body: oneLine(m.body),
          has_artifact: typeof m.artifact === "string" && m.artifact.length > 0,
          ts: m.ts,
        });
        break;
      }
      default:
        break;
    }
  }

  // Participants → sorted by first-appearance (participantOrder is already that).
  const by_participant: DigestParticipant[] = participantOrder.map((owner) => {
    const p = participants.get(owner)!;
    return {
      owner: oneLine(p.owner),
      message_count: p.count,
      agent_ids: p.agentIds.map(oneLine),
    };
  });

  // Claims → split open vs resolved, each in first-appearance order.
  const open_claims: OpenClaim[] = [];
  const resolved_claims: ResolvedClaim[] = [];
  for (const key of claimOrder) {
    const c = claims.get(key)!;
    const actor: ClaimActor = {
      owner: oneLine(c.actor.owner),
      agent_id: oneLine(c.actor.agent_id),
      ts: c.actor.ts,
    };
    if (c.resolved) {
      resolved_claims.push({ target: oneLine(c.target), resolved_by: actor });
    } else {
      open_claims.push({ target: oneLine(c.target), holder: actor });
    }
  }

  // Questions → unanswered list (append order) + answered count.
  const unanswered_questions: UnansweredQuestion[] = [];
  let answered_questions_count = 0;
  for (const q of questions) {
    if (answeredQuestionIds.has(q.msg_id)) {
      answered_questions_count += 1;
    } else {
      unanswered_questions.push({
        msg_id: q.msg_id,
        owner: oneLine(q.owner),
        body: oneLine(q.body),
        ts: q.ts,
      });
    }
  }

  // Key findings → most recent KEY_FINDINGS_CAP, kept in APPEND order.
  const findings_overflow = Math.max(0, findings.length - KEY_FINDINGS_CAP);
  const key_findings =
    findings_overflow > 0 ? findings.slice(findings_overflow) : findings;

  return {
    window: {
      from_cursor: opts.from_cursor,
      to_cursor: opts.to_cursor,
      message_count: messages.length,
    },
    by_type,
    by_participant,
    open_claims,
    resolved_claims,
    unanswered_questions,
    answered_questions_count,
    key_findings,
    findings_overflow,
  };
}

/**
 * Render a single `by_type` count line, e.g. `finding: 3 · claim: 1`. Zero-count
 * types are dropped HERE (markdown surface only) so the line stays scannable;
 * falls back to `_none_` when nothing was posted. The STRUCTURED `by_type`
 * object stays fully zero-filled for byte-identical JSON (determinism B2/B7).
 */
function renderCounts(by_type: ByType): string {
  const parts = MESSAGE_TYPES.filter((t) => by_type[t] > 0).map(
    (t) => `${t}: ${by_type[t]}`,
  );
  return parts.length > 0 ? parts.join(" · ") : "_none_";
}

/** A markdown artifact marker for a finding that links to full content (ADR-C12). */
const ARTIFACT_MARKER = " ↗artifact";

/**
 * Render the SAME {@link DigestStructured} object as a copy-pasteable markdown
 * postmortem skeleton. This is a RENDER of the structured projection, NOT a
 * recomputation. Every poster-controlled fragment (body, owner, claim target,
 * holder/resolver identity) is passed through {@link mdInert} so it cannot forge
 * markdown structure in a pasted doc (ADR-C12); the bodies were already
 * one-lined + control-stripped by {@link buildDigest}.
 *
 * `descriptor` supplies the channel name + purpose for the title; omit it (or
 * its purpose) for the no-purpose title fallback.
 */
export function renderDigestMarkdown(
  digest: DigestStructured,
  descriptor?: { channel: string; purpose?: string },
): string {
  const lines: string[] = [];

  // Title — the incident's identity (channel + purpose), NOT the tool brand.
  // Both poster-controlled → inert. The tool brand moves to a quiet subtitle.
  if (descriptor !== undefined) {
    const channel = mdInert(oneLine(descriptor.channel));
    if (typeof descriptor.purpose === "string" && descriptor.purpose.length > 0) {
      lines.push(`# ${channel} — ${mdInert(oneLine(descriptor.purpose))}`);
    } else {
      lines.push(`# ${channel}`);
    }
  } else {
    lines.push("# War room digest");
  }
  lines.push("_Caucus war-room digest._");
  lines.push("");

  // Participants.
  lines.push("## Participants");
  if (digest.by_participant.length === 0) {
    lines.push("_No participants yet._");
  } else {
    for (const p of digest.by_participant) {
      const agents =
        p.agent_ids.length > 0
          ? ` (as ${p.agent_ids.map((a) => mdInert(a)).join(", ")})`
          : "";
      lines.push(`- ${mdInert(p.owner)} — ${p.message_count}${agents}`);
    }
  }
  lines.push("");

  // Timeline of findings (append order).
  lines.push("## Timeline of findings");
  if (digest.key_findings.length === 0) {
    lines.push("_No findings yet._");
  } else {
    for (const f of digest.key_findings) {
      const marker = f.has_artifact ? ARTIFACT_MARKER : "";
      lines.push(`- ${mdInert(f.owner)} · ${mdInert(f.body)}${marker}`);
    }
    if (digest.findings_overflow > 0) {
      lines.push(
        `_+${digest.findings_overflow} older findings — caucus_read_channel_`,
      );
    }
  }
  lines.push("");

  // Claims (open vs resolved).
  lines.push("## Claims");
  lines.push("### Open");
  if (digest.open_claims.length === 0) {
    lines.push("_None._");
  } else {
    for (const c of digest.open_claims) {
      lines.push(`- ${mdInert(c.target)} — ${mdInert(c.holder.owner)}`);
    }
  }
  lines.push("### Resolved");
  if (digest.resolved_claims.length === 0) {
    lines.push("_None._");
  } else {
    for (const c of digest.resolved_claims) {
      lines.push(`- ${mdInert(c.target)} — ${mdInert(c.resolved_by.owner)}`);
    }
  }
  lines.push("");

  // Open questions.
  lines.push("## Open questions");
  if (digest.unanswered_questions.length === 0) {
    lines.push("_No open questions._");
  } else {
    for (const q of digest.unanswered_questions) {
      lines.push(`- ${mdInert(q.owner)} · ${mdInert(q.body)}`);
    }
  }
  lines.push("");

  // Counts.
  lines.push("## Counts");
  lines.push(renderCounts(digest.by_type));
  lines.push("");

  // Machine-metadata footer: a self-describing line a human can recognize and
  // delete, and an agent can parse for the resume token. The HR separates it
  // from the human-facing body.
  lines.push("---");
  lines.push(
    `_Caucus digest · resume with since=${digest.window.to_cursor} · ${digest.window.message_count} messages in this window._`,
  );

  return lines.join("\n");
}
