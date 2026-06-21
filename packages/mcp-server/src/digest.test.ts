/**
 * Unit tests for the pure digest projection (CAU-19).
 *
 * Fixture-driven, no I/O: messages are hand-built `AppendedMessage`s so a known
 * mix produces known counts/groupings/claims/questions/findings. Covers the
 * deterministic AC B1–B7, the markdown render (C1–C4), and the ADR-C12
 * sanitization guard (C3) in the vision-guard style.
 */
import { describe, expect, it } from "vitest";
import { newMsgId, MESSAGE_TYPES } from "@caucus/schema";
import type { AppendedMessage } from "@caucus/backbone";
import {
  buildDigest,
  renderDigestMarkdown,
  oneLine,
  mdInert,
  DIGEST_BODY_CHARS,
  KEY_FINDINGS_CAP,
} from "./digest.js";

// Control bytes for the sanitization guard, spelled with \x escapes so this
// source file itself stays plain printable ASCII.
const ESC = "\x1b"; // ANSI escape introducer
const C1 = "\x9b"; // a C1 control byte (CSI); JSON.stringify does NOT escape it
const DEL = "\x7f"; // delete

/**
 * Matches any DANGEROUS control byte: C0 except the structural `\n`/`\t`
 * (`\x00–\x08`, `\x0b–\x1f`), DEL (`\x7f`), or C1 (`\x80–\x9f`). Markdown's own
 * line structure uses `\n` legitimately (the render joins lines with it), so the
 * guard must NOT flag `\n` — only the terminal-escape / C1 bytes a poster could
 * smuggle. This mirrors `stripControlCharsKeepWhitespace`'s tolerated set.
 */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

let stamp = 0;
/** A monotonic opaque ts stamp, distinct per message (ordering token only). */
function nextTs(): string {
  stamp += 1;
  return `2026-06-17T00:00:00.000Z#${String(stamp).padStart(12, "0")}`;
}

/** A hand-built appended message with sensible defaults. */
function msg(overrides: Partial<AppendedMessage> & Record<string, unknown> = {}): AppendedMessage {
  return {
    v: 1,
    type: "finding",
    agent_id: "agent-a",
    owner: "alice",
    msg_id: newMsgId(),
    body: "a finding",
    ts: nextTs(),
    ...overrides,
  } as AppendedMessage;
}

const WINDOW = { from_cursor: 0, to_cursor: 10 };

describe("buildDigest — by_type (B2)", () => {
  it("counts every type and sums to message_count, with all types zero-filled", () => {
    const messages = [
      msg({ type: "finding" }),
      msg({ type: "finding" }),
      msg({ type: "claim", target: "t1" }),
      msg({ type: "status", body: "investigating" }),
      msg({ type: "question", body: "why?" }),
      msg({ type: "answer", body: "because" }),
      msg({ type: "note", body: "fyi" }),
      msg({ type: "steer", body: "focus here" }),
    ];
    const d = buildDigest(messages, { from_cursor: 3, to_cursor: 11 });

    // All types present (fixed-key record).
    for (const t of MESSAGE_TYPES) {
      expect(d.by_type[t]).toBeTypeOf("number");
    }
    expect(d.by_type.finding).toBe(2);
    expect(d.by_type.claim).toBe(1);
    expect(d.by_type.status).toBe(1);
    expect(d.by_type.question).toBe(1);
    expect(d.by_type.answer).toBe(1);
    expect(d.by_type.note).toBe(1);
    expect(d.by_type.steer).toBe(1);

    const sum = MESSAGE_TYPES.reduce((acc, t) => acc + d.by_type[t], 0);
    expect(sum).toBe(d.window.message_count);
    expect(d.window).toEqual({ from_cursor: 3, to_cursor: 11, message_count: 8 });
  });
});

describe("buildDigest — by_participant (B3)", () => {
  it("groups by owner, counts per owner, collects unique agent_ids in first-appearance order", () => {
    // 2 owners, 3 sessions: alice posts as agent-a then agent-a2; bob as agent-b.
    const messages = [
      msg({ owner: "alice", agent_id: "agent-a" }),
      msg({ owner: "bob", agent_id: "agent-b" }),
      msg({ owner: "alice", agent_id: "agent-a2" }),
      msg({ owner: "alice", agent_id: "agent-a" }),
    ];
    const d = buildDigest(messages, WINDOW);

    expect(d.by_participant).toHaveLength(2);
    // First-appearance order: alice (idx 0), then bob (idx 1).
    expect(d.by_participant[0]!.owner).toBe("alice");
    expect(d.by_participant[0]!.message_count).toBe(3);
    expect(d.by_participant[0]!.agent_ids).toEqual(["agent-a", "agent-a2"]);
    expect(d.by_participant[1]!.owner).toBe("bob");
    expect(d.by_participant[1]!.message_count).toBe(1);
    expect(d.by_participant[1]!.agent_ids).toEqual(["agent-b"]);
  });
});

describe("buildDigest — claims reconstructed from the log (B4)", () => {
  it("claim A, claim B, resolve A → A resolved, B open", () => {
    const messages = [
      msg({ type: "claim", target: "auth-svc", owner: "alice", agent_id: "agent-a" }),
      msg({ type: "claim", target: "db-svc", owner: "bob", agent_id: "agent-b" }),
      msg({
        type: "claim",
        target: "auth-svc",
        owner: "alice",
        agent_id: "agent-a",
        status: "resolved",
      }),
    ];
    const d = buildDigest(messages, WINDOW);

    expect(d.open_claims.map((c) => c.target)).toEqual(["db-svc"]);
    expect(d.open_claims[0]!.holder.owner).toBe("bob");
    expect(d.resolved_claims.map((c) => c.target)).toEqual(["auth-svc"]);
    expect(d.resolved_claims[0]!.resolved_by.owner).toBe("alice");
  });

  it("reassigned multiple times → latest holder wins, target stays open", () => {
    const messages = [
      msg({ type: "claim", target: "x", owner: "alice", agent_id: "a" }),
      msg({ type: "claim", target: "x", owner: "bob", agent_id: "b" }),
      msg({ type: "claim", target: "x", owner: "carol", agent_id: "c" }),
    ];
    const d = buildDigest(messages, WINDOW);
    expect(d.open_claims).toHaveLength(1);
    expect(d.open_claims[0]!.holder.owner).toBe("carol");
    expect(d.resolved_claims).toHaveLength(0);
  });

  it("resolve-then-reclaim → latest is a live claim, so target is OPEN again", () => {
    const messages = [
      msg({ type: "claim", target: "y", owner: "alice", agent_id: "a" }),
      msg({ type: "claim", target: "y", owner: "alice", agent_id: "a", status: "resolved" }),
      msg({ type: "claim", target: "y", owner: "bob", agent_id: "b" }),
    ];
    const d = buildDigest(messages, WINDOW);
    expect(d.resolved_claims).toHaveLength(0);
    expect(d.open_claims).toHaveLength(1);
    expect(d.open_claims[0]!.holder.owner).toBe("bob");
  });

  it("skips a claim whose target normalizes empty (defensive — never throws on log data)", () => {
    const messages = [
      msg({ type: "claim", target: "   ", owner: "alice", agent_id: "a" }),
      msg({ type: "claim", target: "real-target", owner: "bob", agent_id: "b" }),
    ];
    const d = buildDigest(messages, WINDOW);
    // The whitespace-only target is dropped; only the real one is a claim.
    expect(d.open_claims.map((c) => c.target)).toEqual(["real-target"]);
    expect(d.resolved_claims).toEqual([]);
    // It still counts toward by_type (it IS a claim message).
    expect(d.by_type.claim).toBe(2);
  });

  it("keys targets via normalizeTarget so whitespace/Unicode-form variants collapse", () => {
    const messages = [
      msg({ type: "claim", target: "  café  ", owner: "alice", agent_id: "a" }),
      // NFD spelling of café + surrounding whitespace → same ledger key.
      msg({ type: "claim", target: "café", owner: "bob", agent_id: "b" }),
    ];
    const d = buildDigest(messages, WINDOW);
    expect(d.open_claims).toHaveLength(1);
    expect(d.open_claims[0]!.holder.owner).toBe("bob");
  });
});

describe("buildDigest — questions (B5)", () => {
  it("a question with no resolving answer is unanswered; a resolved answer (by thread or reply_to) closes its question", () => {
    const q1 = msg({ type: "question", owner: "alice", agent_id: "a", body: "q1?" });
    const q2 = msg({ type: "question", owner: "alice", agent_id: "a", body: "q2?" });
    const q3 = msg({ type: "question", owner: "bob", agent_id: "b", body: "q3?" });
    const messages = [
      q1,
      q2,
      q3,
      // q2 answered via thread, status resolved.
      msg({ type: "answer", owner: "bob", agent_id: "b", body: "a2", thread: q2.msg_id, status: "resolved" }),
      // q3 answered via reply_to, status resolved.
      msg({ type: "answer", owner: "alice", agent_id: "a", body: "a3", reply_to: q3.msg_id, status: "resolved" }),
      // q1 has an answer but NOT status:resolved → stays unanswered.
      msg({ type: "answer", owner: "bob", agent_id: "b", body: "a1", thread: q1.msg_id }),
    ];
    const d = buildDigest(messages, WINDOW);

    expect(d.unanswered_questions.map((u) => u.body)).toEqual(["q1?"]);
    expect(d.unanswered_questions[0]!.msg_id).toBe(q1.msg_id);
    expect(d.answered_questions_count).toBe(2);
  });
});

describe("buildDigest — key_findings cap + has_artifact (B6)", () => {
  it("25 findings → last 20 in append order + overflow 5; artifact presence flagged", () => {
    const messages: AppendedMessage[] = [];
    for (let i = 0; i < 25; i++) {
      messages.push(
        msg({
          type: "finding",
          body: `finding ${i}`,
          artifact: i === 24 ? "caucus-artifact://x" : undefined,
        }),
      );
    }
    const d = buildDigest(messages, WINDOW);

    expect(d.key_findings).toHaveLength(KEY_FINDINGS_CAP);
    expect(d.findings_overflow).toBe(5);
    // Last 20 in append order: findings 5..24.
    expect(d.key_findings[0]!.body).toBe("finding 5");
    expect(d.key_findings[KEY_FINDINGS_CAP - 1]!.body).toBe("finding 24");
    // has_artifact only on the one with a non-empty artifact.
    expect(d.key_findings[KEY_FINDINGS_CAP - 1]!.has_artifact).toBe(true);
    expect(d.key_findings[0]!.has_artifact).toBe(false);
  });

  it("empty-string artifact is NOT an artifact", () => {
    const d = buildDigest([msg({ type: "finding", artifact: "" })], WINDOW);
    expect(d.key_findings[0]!.has_artifact).toBe(false);
  });

  it("truncates a long body to the cap with an ellipsis", () => {
    const long = "x".repeat(DIGEST_BODY_CHARS + 50);
    const d = buildDigest([msg({ type: "finding", body: long })], WINDOW);
    const body = d.key_findings[0]!.body;
    expect(body.length).toBe(DIGEST_BODY_CHARS + 1); // +1 for the … marker
    expect(body.endsWith("…")).toBe(true);
  });
});

describe("buildDigest — determinism (B7)", () => {
  it("the same window over the same log is deep-equal AND byte-identical", () => {
    const messages = [
      msg({ type: "finding", owner: "alice", agent_id: "a", body: "f1" }),
      msg({ type: "claim", target: "t", owner: "bob", agent_id: "b" }),
      msg({ type: "question", owner: "alice", agent_id: "a", body: "q?" }),
      msg({ type: "answer", owner: "bob", agent_id: "b", body: "ans", status: "resolved" }),
      msg({ type: "steer", owner: "carol", agent_id: "c", body: "steer" }),
    ];
    const a = buildDigest(messages, WINDOW);
    const b = buildDigest(messages, WINDOW);
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("buildDigest — empty channel (B1/C4)", () => {
  it("produces a well-formed, zero-filled digest with no throw", () => {
    const d = buildDigest([], { from_cursor: 0, to_cursor: 0 });
    expect(d.window).toEqual({ from_cursor: 0, to_cursor: 0, message_count: 0 });
    for (const t of MESSAGE_TYPES) expect(d.by_type[t]).toBe(0);
    expect(d.by_participant).toEqual([]);
    expect(d.open_claims).toEqual([]);
    expect(d.resolved_claims).toEqual([]);
    expect(d.unanswered_questions).toEqual([]);
    expect(d.answered_questions_count).toBe(0);
    expect(d.key_findings).toEqual([]);
    expect(d.findings_overflow).toBe(0);
  });
});

describe("oneLine + mdInert helpers", () => {
  it("oneLine collapses whitespace, strips control bytes, trims", () => {
    expect(oneLine("  step 1\n\tstep 2  ")).toBe("step 1 step 2");
    expect(oneLine(`a${ESC}[31mb${C1}c${DEL}`)).toBe("a[31mbc");
  });

  it("mdInert escapes mid-line-active markdown metacharacters", () => {
    expect(mdInert("## heading")).toBe("\\#\\# heading");
    // Link brackets are escaped; the `](` sequence can never form, so the URL
    // parens no longer need escaping (CAU-123).
    expect(mdInert("[evil](http://x)")).toBe("\\[evil\\](http://x)");
    expect(mdInert("a*b_c`d|e>f")).toBe("a\\*b\\_c\\`d\\|e\\>f");
    // Backslash escaped first so escapes are not double-escaped.
    expect(mdInert("a\\b")).toBe("a\\\\b");
  });

  it("mdInert does NOT escape parens — lone parens are inert prose (CAU-123)", () => {
    // A parenthesis is markdown-active only as a link URL delimiter (after `](`),
    // and `[`/`]` are escaped, so a lone `(`/`)` is safe literal text. Ordinary
    // prose stays clean rather than rendering as `\(qa5\)`.
    expect(mdInert("auth-timeout repro (qa5)")).toBe("auth-timeout repro (qa5)");
    expect(mdInert("(stack trace)")).toBe("(stack trace)");
    // Even adjacent to escaped brackets, the parens themselves stay literal.
    expect(mdInert("a]b(c)")).toBe("a\\]b(c)");
  });

  it("mdInert does NOT escape +, -, . (structural only at line-start; fragments are mid-line)", () => {
    // Hyphenated identifiers and versions stay clean in human-pasted postmortems.
    expect(mdInert("incident-1")).toBe("incident-1");
    expect(mdInert("auth-service")).toBe("auth-service");
    expect(mdInert("v1.2.3")).toBe("v1.2.3");
    expect(mdInert("a+b")).toBe("a+b");
  });
});

describe("renderDigestMarkdown — layout (C1/C2/C4)", () => {
  it("renders all sections in order with a title, subtitle + resume footer", () => {
    const f = msg({ type: "finding", owner: "alice", agent_id: "a", body: "found a bug", artifact: "caucus-artifact://x" });
    const q = msg({ type: "question", owner: "bob", agent_id: "b", body: "is it fixed?" });
    const messages = [
      f,
      msg({ type: "claim", target: "auth", owner: "alice", agent_id: "a" }),
      msg({ type: "claim", target: "db", owner: "bob", agent_id: "b", status: "resolved" }),
      q,
    ];
    const d = buildDigest(messages, { from_cursor: 0, to_cursor: 4 });
    const md = renderDigestMarkdown(d, { channel: "incident-7", purpose: "checkout 500s" });

    // H1 is the incident's identity (channel — purpose), NOT the tool brand.
    // The hyphen in `incident-7` is no longer escaped (mid-line, not structural).
    expect(md).toContain("# incident-7 — checkout 500s");
    // The tool brand is a quiet subtitle right under the H1.
    expect(md).toContain("_Caucus war-room digest._");
    expect(md).not.toContain("# Caucus war room");
    // Section order.
    const idxParticipants = md.indexOf("## Participants");
    const idxTimeline = md.indexOf("## Timeline of findings");
    const idxClaims = md.indexOf("## Claims");
    const idxQuestions = md.indexOf("## Open questions");
    const idxCounts = md.indexOf("## Counts");
    expect(idxParticipants).toBeGreaterThan(0);
    expect(idxParticipants).toBeLessThan(idxTimeline);
    expect(idxTimeline).toBeLessThan(idxClaims);
    expect(idxClaims).toBeLessThan(idxQuestions);
    expect(idxQuestions).toBeLessThan(idxCounts);
    expect(md).toContain("### Open");
    expect(md).toContain("### Resolved");
    expect(md).toContain("↗artifact");
    expect(md).toContain("found a bug");
    expect(md).toContain("is it fixed?");
    // Self-describing machine-metadata footer (HR + labeled resume line).
    expect(md).toContain("---");
    expect(md).toContain(
      "_Caucus digest · resume with since=4 · 4 messages in this window._",
    );
  });

  it("renders parens in body text literally, not backslash-escaped (CAU-123)", () => {
    const messages = [
      msg({
        type: "finding",
        owner: "qa",
        agent_id: "a",
        body: "auth-timeout repro (qa5)",
      }),
    ];
    const d = buildDigest(messages, WINDOW);
    const md = renderDigestMarkdown(d, { channel: "incident-9" });

    // Parens render literally — no `\(`/`\)` noise.
    expect(md).toContain("auth-timeout repro (qa5)");
    expect(md).not.toContain("\\(");
    expect(md).not.toContain("\\)");
    // The injection guard still holds: link syntax can't form.
    expect(md).not.toContain("](");
  });

  it("title fallback without purpose, and empty-section stubs", () => {
    const d = buildDigest([], { from_cursor: 0, to_cursor: 0 });
    const md = renderDigestMarkdown(d, { channel: "quiet-room" });
    // Hyphen no longer escaped; H1 is just the channel, no em-dash separator.
    expect(md).toContain("# quiet-room");
    expect(md).toContain("_Caucus war-room digest._");
    expect(md).not.toContain(" — ");
    expect(md).toContain("_No participants yet._");
    expect(md).toContain("_No findings yet._");
    expect(md).toContain("_None._");
    expect(md).toContain("_No open questions._");
    // No-descriptor fallback title.
    const md2 = renderDigestMarkdown(d);
    expect(md2).toContain("# War room digest");
  });

  it("the markdown counts line drops zero-count types but the structured by_type stays zero-filled", () => {
    const messages = [
      msg({ type: "finding", body: "f" }),
      msg({ type: "finding", body: "g" }),
      msg({ type: "claim", target: "t", owner: "alice", agent_id: "a" }),
    ];
    const d = buildDigest(messages, WINDOW);
    const md = renderDigestMarkdown(d, { channel: "c" });

    // Markdown surface: only the non-zero types appear on the Counts line.
    const countsLine = md.split("\n")[md.split("\n").indexOf("## Counts") + 1]!;
    expect(countsLine).toBe("finding: 2 · claim: 1");
    expect(countsLine).not.toContain("question:");
    expect(countsLine).not.toContain(": 0");

    // Structured object: ALL types present, zero-filled (determinism B2/B7).
    for (const t of MESSAGE_TYPES) expect(d.by_type[t]).toBeTypeOf("number");
    expect(d.by_type.question).toBe(0);
  });

  it("the markdown counts line falls back to _none_ on an empty window", () => {
    const d = buildDigest([], { from_cursor: 0, to_cursor: 0 });
    const md = renderDigestMarkdown(d, { channel: "c" });
    const countsLine = md.split("\n")[md.split("\n").indexOf("## Counts") + 1]!;
    expect(countsLine).toBe("_none_");
  });

  it("renders the findings overflow line when capped", () => {
    const messages: AppendedMessage[] = [];
    for (let i = 0; i < 23; i++) messages.push(msg({ type: "finding", body: `f${i}` }));
    const d = buildDigest(messages, WINDOW);
    const md = renderDigestMarkdown(d, { channel: "c" });
    expect(md).toContain("_+3 older findings — caucus_read_channel_");
  });
});

describe("renderDigestMarkdown — ADR-C12 sanitization guard (C3, vision-guard style)", () => {
  it("neutralizes control bytes and markdown injection in EVERY poster-controlled fragment", () => {
    const messages: AppendedMessage[] = [
      msg({
        type: "finding",
        owner: `mallory${C1}`,
        agent_id: `agent${DEL}x`,
        body: `${ESC}[31mred\n## Forged Heading\n[evil](http://x)`,
      }),
      msg({
        type: "claim",
        target: `tgt${ESC}[2J\n## Also Forged`,
        owner: `claimer${C1}`,
        agent_id: "c",
      }),
      msg({
        type: "question",
        owner: `asker${ESC}`,
        agent_id: "q",
        body: `why ${C1}\n### sneaky`,
      }),
    ];
    const d = buildDigest(messages, WINDOW);
    const md = renderDigestMarkdown(d, {
      channel: `chan${C1}`,
      purpose: `purpose\n## Injected Purpose`,
    });

    // No C0/C1/DEL bytes survive anywhere in the markdown.
    expect(CONTROL_CHARS.test(md)).toBe(false);

    // The ONLY '## ' headings are the known sections — no forged heading.
    const headings = md.split("\n").filter((l) => /^## /.test(l));
    expect(headings.sort()).toEqual(
      ["## Claims", "## Counts", "## Open questions", "## Participants", "## Timeline of findings"].sort(),
    );
    // And no forged sub-heading sneaks in.
    expect(md).not.toContain("### sneaky");
    expect(md).not.toContain("## Forged Heading");
    expect(md).not.toContain("## Injected Purpose");

    // Link syntax can't form: any `](` is broken by an escaped `\]` (CAU-123 no
    // longer escapes the paren, but the `]` IS escaped, so a markdown renderer
    // sees `\]` + `(` — not a link). Assert there is no UNESCAPED `](` (a `](`
    // not preceded by a backslash), which is the real injection invariant.
    expect(/(^|[^\\])\]\(/.test(md)).toBe(false);
  });

  it("structured JSON stays raw-but-control-stripped (no mdInert escaping)", () => {
    const d = buildDigest(
      [msg({ type: "finding", owner: "alice", body: `has #hash and ${C1}control` })],
      WINDOW,
    );
    // The body keeps the raw # (JSON is not a markdown surface) but the C1 byte is stripped.
    expect(d.key_findings[0]!.body).toBe("has #hash and control");
    const json = JSON.stringify(d);
    expect(CONTROL_CHARS.test(json)).toBe(false);
    // Not markdown-escaped: no backslash before the #.
    expect(json).not.toContain("\\\\#");
  });
});
