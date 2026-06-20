/**
 * The single read-path message sanitizer (CAU-73, lifted in CAU-17).
 *
 * Any consumer that serializes a stored log message into another principal's
 * model context, terminal, or stream MUST pass it through
 * {@link sanitizeMessageFields} first. It neutralizes terminal control
 * characters in the untrusted, poster-controlled string fields of a message —
 * `body`, `owner`, `agent_id`, claim `target`, the `artifact` URL, and each
 * `to[]` entry — while leaving structural/validated fields (`msg_id`/`ts`/`v`/
 * `thread`/`reply_to`) and the enum-safe `status`/`type` untouched.
 *
 * **Why it lives here, and why there is exactly one copy.** Writes now REJECT
 * control bytes at the schema validator (CAU-71), so this strip is the second
 * defense layer: it covers pre-CAU-71 log content and any future write path
 * that skips validation. It must be IDENTICAL across every read surface —
 * `caucus_read_channel` (the MCP tool, CAU-10) and the SSE log-tail stream
 * (CAU-17) both serialize the SAME message into a human/agent context, and
 * ADR-C15 requires their frames be byte-identical. Keeping one function in
 * `@caucus/schema` (the leaf both packages depend on) makes drift impossible:
 * a divergence would mean a new leak class on one surface but not the other.
 *
 * `body` uses {@link stripControlCharsKeepWhitespace} so a multi-line body keeps
 * its `\n`/`\t` (JSON-escaped, terminal-inert, and useful line structure for the
 * receiving model) instead of gluing words across lines; the single-token
 * identity/target/addressee fields and the URL have no legitimate whitespace, so
 * they use the plain {@link stripControlChars}. `JSON.stringify` escapes
 * C0/ANSI-ESC bytes but passes C1 (`\x80–\x9f`) through verbatim, so without
 * this strip a poster could smuggle a C1 control sequence cross-principal
 * (CAU-73).
 */
import {
  stripControlChars,
  stripControlCharsKeepWhitespace,
} from "./sanitize.js";
import type { CaucusMessage } from "./types.js";

/**
 * Return a copy of `m` with its untrusted, poster-controlled string fields
 * stripped of terminal control characters (see the module doc). The input is
 * never mutated. Generic over the concrete message type (e.g. the backbone's
 * `AppendedMessage`, which is `CaucusMessage & { ts: string }`) so the returned
 * value keeps the caller's narrower type — including the always-present `ts`.
 */
export function sanitizeMessageFields<M extends CaucusMessage>(m: M): M {
  const sanitized = {
    ...m,
    body: stripControlCharsKeepWhitespace(m.body),
    owner: stripControlChars(m.owner),
  } as M & { target?: string; artifact?: string; to?: string[] };
  if (typeof m.agent_id === "string") {
    sanitized.agent_id = stripControlChars(m.agent_id);
  }
  if (typeof sanitized.target === "string") {
    sanitized.target = stripControlChars(sanitized.target);
  }
  if (typeof m.artifact === "string") {
    sanitized.artifact = stripControlChars(m.artifact);
  }
  if (m.to !== undefined) {
    sanitized.to = m.to.map(stripControlChars);
  }
  return sanitized;
}
