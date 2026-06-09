/**
 * Shared terminal-control-character handling for untrusted, poster-controlled
 * string fields (CAU-69, CAU-73, CAU-71). This module is the single byte-set
 * authority for BOTH defense layers:
 *
 * - **Write layer (CAU-71):** the schema validator and the backbone's
 *   `createChannel` boundary use the {@link containsControlChars} /
 *   {@link containsControlCharsExceptWhitespace} predicates to REJECT
 *   control-character-bearing fields, so escape-bearing content never enters
 *   the append-only log in the first place.
 * - **Read/display layer (CAU-69, CAU-73):** any consumer that prints or
 *   forwards log content — the CAU-14 hook injection, the demo `watch`, the
 *   `caucus_read_channel` MCP tool, and the `caucus_list_channels` /
 *   `caucus_describe_channel` descriptor tools — MUST pass the untrusted
 *   fields through {@link stripControlChars} (or its whitespace-preserving
 *   sibling {@link stripControlCharsKeepWhitespace} for structured JSON
 *   reads). This layer stays even though writes now reject: it covers any
 *   pre-tightening log content and is defense-in-depth against a future write
 *   path that skips validation.
 *
 * Together these stop a token-holding poster smuggling terminal escapes
 * (ANSI/OSC) or C1 bytes into another principal's context or TTY.
 *
 * This lives in `@caucus/schema` because it is the one package the hook, the
 * MCP server, and the backbone all already depend on; keeping a single
 * implementation here prevents the write and read layers from drifting (the
 * predicates are DERIVED from the strip functions, so the byte sets cannot
 * diverge).
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

/**
 * True iff `s` contains any C0 (`\x00–\x1f`), DEL (`\x7f`), or C1 (`\x80–\x9f`)
 * byte.
 *
 * The write-layer rejection predicate (CAU-71). Deliberately DERIVED from
 * {@link stripControlChars} rather than re-spelling the ranges: the strip
 * function is the one byte-set authority, so the write layer can never drift
 * from the read layer.
 */
export function containsControlChars(s: string): boolean {
  return stripControlChars(s) !== s;
}

/**
 * Like {@link containsControlChars}, but tolerates `\t` and `\n` (the
 * body-safe whitespace).
 *
 * Used at write time (CAU-71) for the multi-line free-text fields — message
 * `body` and channel `purpose` — where `\t`/`\n` are legitimate structure.
 * Derived from {@link stripControlCharsKeepWhitespace} for the same
 * drift-proofing as {@link containsControlChars}.
 */
export function containsControlCharsExceptWhitespace(s: string): boolean {
  return stripControlCharsKeepWhitespace(s) !== s;
}
