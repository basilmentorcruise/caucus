/**
 * Shared terminal-control-character sanitization for untrusted, poster-
 * controlled string fields (CAU-69, CAU-73).
 *
 * Caucus stores message content raw in its append-only log; sanitization is a
 * READ/DISPLAY-time defense (write-time rejection is the deeper #71 follow-up).
 * Any consumer that prints or forwards log content — the CAU-14 hook injection,
 * the demo `watch`, the `caucus_read_channel` MCP tool, and the
 * `caucus_list_channels` / `caucus_describe_channel` descriptor tools — MUST
 * pass the untrusted fields through {@link stripControlChars} (or its
 * whitespace-preserving sibling {@link stripControlCharsKeepWhitespace} for
 * structured JSON reads) so a token-holding poster cannot smuggle terminal
 * escapes (ANSI/OSC) or C1 bytes into another principal's context or TTY.
 *
 * This lives in `@caucus/schema` because it is the one package both the hook
 * and the MCP server already depend on; keeping a single implementation here
 * prevents the two render paths from drifting (the original lived only in
 * `packages/hook/src/render.ts`).
 */

/**
 * Remove terminal control characters from an untrusted, poster-controlled
 * string.
 *
 * We **strip** rather than replace with a placeholder: the consuming surfaces
 * (a single rendered hook line, a serialized read-channel page) have no
 * legitimate control character to preserve, and removal keeps the output clean.
 * The ranges neutralized are the C0 controls `\x00–\x1f` (this includes
 * `\n`/`\t`), DEL `\x7f`, and the C1 controls `\x80–\x9f`. Printable ASCII
 * `\x20–\x7e` and all multibyte UTF-8 (e.g. `↗`, `é`, `·`) pass through
 * untouched. This is a deliberate byte neutralization, NOT an ANSI-aware
 * parser.
 *
 * C1 (`\x80–\x9f`) matters specifically for serialization consumers:
 * `JSON.stringify` does NOT escape C1 bytes (unlike C0 / DEL-adjacent bytes),
 * so without this strip a C1-bearing payload read via `caucus_read_channel`
 * would reach another agent's context verbatim (CAU-73).
 */
export function stripControlChars(s: string): string {
  // C0 (\x00–\x1f) + DEL (\x7f) + C1 (\x80–\x9f). Written with \x escapes so the
  // source stays plain ASCII and the intent is auditable at a glance.
  // eslint-disable-next-line no-control-regex -- intentionally matching control bytes
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

/**
 * Like {@link stripControlChars}, but PRESERVES the two structural whitespace
 * controls `\t` (`\x09`) and `\n` (`\x0a`) while removing every other C0/DEL/C1
 * control byte (incl. `\r`, ESC, BEL, and the C1 range).
 *
 * This is for structured-read consumers — `caucus_read_channel` — that serialize
 * a field with `JSON.stringify`. There, `\n`/`\t` are *safe* (JSON escapes them
 * to `\n`/`\t`, they cannot drive a terminal) and *useful* (the receiving model
 * benefits from a multi-line body's line structure), so stripping them would
 * needlessly glue words across lines (`"step 1\nstep 2"` → `"step 1step 2"`).
 *
 * The hook's TTY render path does NOT use this: it collapses whitespace to
 * single spaces in `renderBody` BEFORE calling {@link stripControlChars}, so its
 * one-line output is unaffected. Keeping the two functions separate is
 * deliberate — changing the shared {@link stripControlChars} to keep whitespace
 * would alter render output, so the whitespace-preserving behavior lives here.
 */
export function stripControlCharsKeepWhitespace(s: string): string {
  // Same ranges as stripControlChars, minus \x09 (TAB) and \x0a (LF):
  // \x00–\x08, \x0b–\x1f, DEL \x7f, C1 \x80–\x9f.
  // eslint-disable-next-line no-control-regex -- intentionally matching control bytes
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
