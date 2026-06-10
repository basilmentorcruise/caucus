/**
 * PURE rendering of channel messages into the injected-context block (CAU-14).
 *
 * No I/O, no clock, no env — every function here is a deterministic
 * string→string transform, so it is exhaustively unit-testable. The hook leads
 * each line with identity and type (per
 * docs/MESSAGE_SCHEMA.md#how-the-hook-renders-an-injected-message) so a human
 * scanning their session sees who/what at a glance:
 *
 *     [caucus] claim   A·alice  "auth-timeout repro"
 *     [caucus] finding A·alice  /login accepts expired JWTs (sig not re-checked)  ↗artifact
 *     [caucus] note    C·carol  Human steer: check the 14:02 deploy  @bob-agent
 *
 * ADR-C12: the artifact URL is NEVER rendered — only a `↗artifact` marker — so a
 * link with a token/secret in it can't be surfaced into context.
 *
 * ## The delimiter is a stable, quotable VISUAL boundary (CAU-93)
 *
 * {@link DELTA_HEADER} and {@link DELTA_FOOTER} are a LOAD-BEARING, documented
 * contract: an agent may be told (via hook/tool copy) that it can quote the text
 * between these two `=== … ===` markers verbatim, and a human auditing "did the
 * hook actually deliver?" can verify delivery from the session itself rather than
 * from checkpoint state alone. Changing either string is a behavioural break —
 * `render.test.ts` pins them with a literal-string assertion that fails loudly.
 *
 * They are a VISUAL boundary, NOT a parser-trusted frame. Body content that
 * happens to contain the literal sentinel is harmless: every message renders on a
 * `[caucus] ` line and bodies are control-stripped/one-lined, so a body can never
 * forge an extra header/footer that the reader would mistake for the real frame.
 * We deliberately do NOT add any parsing that would let body text inject a
 * delimiter — the frame is emitted only by {@link renderDelta}.
 */
import {
  INJECTED_DELTA_CAP_CHARS,
  MESSAGE_TYPES,
  stripControlChars,
} from "@caucus/schema";
import { DEFAULT_RENDER_BUDGET_CHARS } from "@caucus/backbone";
import type { AppendedMessage } from "@caucus/backbone";

// Re-exported so existing importers (and the CAU-69 render tests) can keep
// reaching `stripControlChars` from `./render.js`. The implementation now lives
// in `@caucus/schema` so the hook render path and the `caucus_read_channel` MCP
// tool share one sanitizer (CAU-73); this module no longer owns it.
export { stripControlChars };

/** Width the type column is padded to (longest type is `question` = 8). */
const TYPE_WIDTH = Math.max(...MESSAGE_TYPES.map((t) => t.length));

/** The opening line of the injected block. */
export const DELTA_HEADER = "=== CAUCUS CHANNEL (new since last turn) ===";
/** The closing line of the injected block. */
export const DELTA_FOOTER = "=== END CAUCUS ===";

/**
 * Truncate `body` to `budget` characters, appending an explicit, actionable
 * affordance when it was actually shortened (CAU-94). Rather than silently
 * dropping the tail behind a bare `…`, a truncated body renders
 * `… +truncated, <N> chars — caucus_read_channel` where `N` is the number of
 * characters dropped (`oneLine.length - budget`, measured AFTER the
 * whitespace-collapse below), so the agent knows a fuller body exists and how to
 * fetch it via the MCP tool. The body cap is a per-channel knob
 * (`renderBudgetChars`, default {@link DEFAULT_RENDER_BUDGET_CHARS}) threaded in
 * by the caller; the OVERALL delta cap ({@link INJECTED_DELTA_CAP_CHARS}) in
 * {@link renderDelta} is independent.
 *
 * Whitespace (incl. `\n`/`\t`) is collapsed to single spaces FIRST so word
 * boundaries survive, THEN control characters are stripped (CAU-69): `\n`/`\t`
 * are both whitespace and C0 controls, so collapsing before stripping turns them
 * into the spaces a reader expects rather than deleting the boundary; the
 * non-whitespace control bytes (ESC/BEL/DEL/C1) are not affected by the collapse
 * and are removed by the strip. A final trim drops any edge space left once a
 * leading/trailing control byte is removed.
 */
function renderBody(body: string, budget: number): string {
  const oneLine = stripControlChars(body.replace(/\s+/g, " ")).trim();
  if (oneLine.length <= budget) return oneLine;
  const dropped = oneLine.length - budget;
  return `${oneLine.slice(0, budget)}… +truncated, ${dropped} chars — caucus_read_channel`;
}

/**
 * Render one message as a single compact line. Identity is `A·<owner>` (the
 * agent acts for the human `owner`, ADR-C7). Order of trailing annotations:
 * the (truncated) body, then a `[status]` tag when present, then `@to` when the
 * message is addressed, then a `↗artifact` marker (never the URL — ADR-C12).
 *
 * For a `claim`, the claimed target is quoted up front (it's the load-bearing
 * fact of a claim — "who took what"), followed by any body the author added.
 *
 * Every untrusted, poster-controlled field interpolated here (`owner`, claim
 * `target`, `to[]`, `body`) is passed through {@link stripControlChars} so no
 * terminal escape survives onto the hook-injection path or the TTY (CAU-69).
 * `status` is enum-validated upstream and `artifact` renders only a marker
 * (never its URL — ADR-C12), so neither needs sanitizing.
 *
 * `budget` is the per-message body render budget (CAU-94), passed through from
 * the channel descriptor's `renderBudgetChars`; it bounds only the body, not the
 * identity/annotation columns.
 */
export function renderMessage(
  m: AppendedMessage,
  budget: number = DEFAULT_RENDER_BUDGET_CHARS,
): string {
  const type = m.type.padEnd(TYPE_WIDTH);
  const who = `A·${stripControlChars(m.owner)}`;

  const parts: string[] = [];
  if (m.type === "claim") {
    parts.push(`"${stripControlChars(m.target)}"`);
  }
  const body = renderBody(m.body, budget);
  if (body !== "") parts.push(body);
  if (m.status !== undefined) parts.push(`[${m.status}]`);
  if (m.to !== undefined && m.to.length > 0) {
    parts.push(m.to.map((agent) => `@${stripControlChars(agent)}`).join(" "));
  }
  if (m.artifact !== undefined && m.artifact !== "") {
    parts.push("↗artifact");
  }

  return `[caucus] ${type} ${who}  ${parts.join("  ")}`;
}

/**
 * The audit line emitted just under {@link DELTA_HEADER} (CAU-93). It carries the
 * checkpoint `cursor` the hook advanced to this turn, so a human can confirm
 * delivery ("the hook ran, here's where it got to") and the agent is pointed at
 * the quotable boundary. One calm `[caucus] ` line (ADR-C6); it carries only the
 * integer cursor — no field values, no secrets (ADR-C12).
 */
function auditLine(cursor: number): string {
  return `[caucus] delivered — cursor ${cursor} · quote between the === markers to verify`;
}

/**
 * Render a delta of `messages` into the wrapped, size-capped injection block.
 *
 * - Empty input ⇒ `""` (inject nothing — ADR-C6 quiet default).
 * - Otherwise the lines are wrapped in {@link DELTA_HEADER}/{@link DELTA_FOOTER},
 *   with an {@link auditLine} carrying `cursor` just under the header (CAU-93).
 * - Each message body is rendered under `budget` characters (CAU-94, the
 *   channel's `renderBudgetChars`); a truncated body carries an explicit
 *   `+truncated, N chars — caucus_read_channel` affordance.
 * - The whole block (wrapper + audit line + any overflow line + message lines,
 *   joined by newlines) is kept within `cap` characters. When it would exceed
 *   the cap, the OLDEST message lines are dropped and a `+N older messages — use
 *   caucus_read_channel` line is prepended so the reader knows to catch up via
 *   the MCP tool. The cap accounts for the wrapper, the audit line, and the
 *   overflow line.
 *
 * If even a single newest message plus the wrapper + audit + overflow line
 * cannot fit, that one message is still kept (we never emit an empty body block);
 * the overflow line communicates how many were dropped.
 */
export function renderDelta(
  messages: readonly AppendedMessage[],
  cursor: number,
  budget: number = DEFAULT_RENDER_BUDGET_CHARS,
  cap: number = INJECTED_DELTA_CAP_CHARS,
): string {
  if (messages.length === 0) return "";

  const lines = messages.map((m) => renderMessage(m, budget));
  const audit = auditLine(cursor);

  // Assemble the exact block string for a set of body lines (newline-joined,
  // wrapped, audit line pinned under the header). Measuring the assembled string
  // is what makes the cap accounting exact: header + audit + footer + every
  // interior newline are all counted, so a block sized exactly at `cap` is kept
  // and one char over triggers overflow.
  const assemble = (bodyLines: readonly string[]): string =>
    `${DELTA_HEADER}\n${audit}\n${bodyLines.join("\n")}\n${DELTA_FOOTER}`;

  /** The overflow notice for `dropped` elided messages. Length grows with N. */
  const overflowLine = (dropped: number): string =>
    `+${dropped} older messages — use caucus_read_channel`;

  // Try the whole thing first.
  const whole = assemble(lines);
  if (whole.length <= cap) return whole;

  // Over budget: keep the newest lines, prepend an overflow line for the rest.
  // Walk n (count kept) from all-but-the-overflow down to 1 and take the LARGEST
  // n whose assembled block (with the overflow line, whose digit count can grow)
  // still fits. If even one newest line doesn't fit, we still keep it: an empty
  // body block would be worse than a slightly-over one, and the overflow line
  // still tells the reader to catch up.
  let keepCount = 1;
  for (let n = lines.length; n >= 1; n--) {
    const block = assemble([overflowLine(lines.length - n), ...lines.slice(lines.length - n)]);
    if (block.length <= cap) {
      keepCount = n;
      break;
    }
  }

  return assemble([
    overflowLine(lines.length - keepCount),
    ...lines.slice(lines.length - keepCount),
  ]);
}
