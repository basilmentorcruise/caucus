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
 */
import {
  INJECTED_DELTA_CAP_CHARS,
  MESSAGE_TYPES,
  stripControlChars,
} from "@caucus/schema";
import type { AppendedMessage } from "@caucus/backbone";

// Re-exported so existing importers (and the CAU-69 render tests) can keep
// reaching `stripControlChars` from `./render.js`. The implementation now lives
// in `@caucus/schema` so the hook render path and the `caucus_read_channel` MCP
// tool share one sanitizer (CAU-73); this module no longer owns it.
export { stripControlChars };

/** Max body characters rendered on one line; the rest is elided with `…`. */
export const BODY_TRUNCATE_CHARS = 200;

/** Width the type column is padded to (longest type is `question` = 8). */
const TYPE_WIDTH = Math.max(...MESSAGE_TYPES.map((t) => t.length));

/** The opening line of the injected block. */
export const DELTA_HEADER = "=== CAUCUS CHANNEL (new since last turn) ===";
/** The closing line of the injected block. */
export const DELTA_FOOTER = "=== END CAUCUS ===";

/**
 * Truncate `body` to {@link BODY_TRUNCATE_CHARS}, appending `…` when it was
 * actually shortened. Whitespace (incl. `\n`/`\t`) is collapsed to single
 * spaces FIRST so word boundaries survive, THEN control characters are stripped
 * (CAU-69): `\n`/`\t` are both whitespace and C0 controls, so collapsing before
 * stripping turns them into the spaces a reader expects rather than deleting the
 * boundary; the non-whitespace control bytes (ESC/BEL/DEL/C1) are not affected
 * by the collapse and are removed by the strip. A final trim drops any edge
 * space left once a leading/trailing control byte is removed.
 */
function renderBody(body: string): string {
  const oneLine = stripControlChars(body.replace(/\s+/g, " ")).trim();
  if (oneLine.length <= BODY_TRUNCATE_CHARS) return oneLine;
  return `${oneLine.slice(0, BODY_TRUNCATE_CHARS)}…`;
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
 */
export function renderMessage(m: AppendedMessage): string {
  const type = m.type.padEnd(TYPE_WIDTH);
  const who = `A·${stripControlChars(m.owner)}`;

  const parts: string[] = [];
  if (m.type === "claim") {
    parts.push(`"${stripControlChars(m.target)}"`);
  }
  const body = renderBody(m.body);
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
 * Render a delta of `messages` into the wrapped, size-capped injection block.
 *
 * - Empty input ⇒ `""` (inject nothing — ADR-C6 quiet default).
 * - Otherwise the lines are wrapped in {@link DELTA_HEADER}/{@link DELTA_FOOTER}.
 * - The whole block (wrapper + any overflow line + message lines, joined by
 *   newlines) is kept within `cap` characters. When it would exceed the cap, the
 *   OLDEST message lines are dropped and a `+N older messages — use
 *   caucus_read_channel` line is prepended so the reader knows to catch up via
 *   the MCP tool. The cap accounts for the wrapper and the overflow line.
 *
 * If even a single newest message plus the wrapper + overflow line cannot fit,
 * that one message is still kept (we never emit an empty body block); the
 * overflow line communicates how many were dropped.
 */
export function renderDelta(
  messages: readonly AppendedMessage[],
  cap: number = INJECTED_DELTA_CAP_CHARS,
): string {
  if (messages.length === 0) return "";

  const lines = messages.map(renderMessage);

  // Assemble the exact block string for a set of body lines (newline-joined,
  // wrapped). Measuring the assembled string is what makes the cap accounting
  // exact: header + footer + every interior newline are all counted, so a block
  // sized exactly at `cap` is kept and one char over triggers overflow.
  const assemble = (bodyLines: readonly string[]): string =>
    `${DELTA_HEADER}\n${bodyLines.join("\n")}\n${DELTA_FOOTER}`;

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
