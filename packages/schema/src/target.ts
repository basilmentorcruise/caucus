/**
 * Claim-`target` normalization. Lives in the schema so the MCP server and the
 * backbone derive the same first-write-wins key from a raw target string.
 *
 * v0 policy (ADR-C5, ratified CAU-3): a single `trim()` then Unicode NFC
 * normalization, exact-string match after that. No case-folding and no fuzzy
 * matching in v0. NFC ensures the two canonically-equivalent spellings of an
 * accented target (precomposed "café" vs. decomposed "café") derive the SAME
 * ledger key, so claim dedup is not defeated by Unicode form (ADR-C5). Note
 * this does NOT strip zero-width characters: a target containing a ZWSP stays
 * distinct from one without — accepted v0 behavior.
 *
 * Note: `normalizeTarget` is NOT applied by the codec — the stored `target`
 * stays exactly as authored. The backbone/MCP derive the claim-ledger key by
 * calling this themselves; storage is never pre-normalized.
 */
import { MalformedMessageError } from "./errors.js";

/**
 * Normalize a raw claim target into its ledger key. Trims surrounding
 * whitespace, then applies Unicode NFC normalization, and preserves case and
 * internal whitespace exactly. Throws {@link MalformedMessageError} if the
 * target is empty after trimming.
 */
export function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new MalformedMessageError(["target must not be empty"]);
  }
  return trimmed.normalize("NFC");
}
