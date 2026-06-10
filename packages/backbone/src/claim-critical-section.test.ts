/**
 * Automated guard for the claim atomicity invariant (CAU-76, item from the
 * CAU-4 security review).
 *
 * `InMemoryBackbone.claim()` is a first-write-wins compare-and-set ONLY because
 * no `await` (and no `yield`) sits between the ledger read
 * (`claimLedger.get`) and the ledger write (`claimLedger.set`): JavaScript's
 * run-to-completion semantics make the whole region atomic with respect to
 * other claims. That invariant used to live only in a comment — one innocent
 * `await` inserted during a refactor would silently turn the dedup guarantee
 * into a race.
 *
 * This test makes the invariant executable: it reads `in-memory.ts` SOURCE,
 * extracts the region between the explicit `CLAIM-CRITICAL-SECTION-BEGIN` /
 * `CLAIM-CRITICAL-SECTION-END` markers (robust to refactors — move the code
 * and the markers move with it), strips comments (the surrounding prose
 * legitimately SAYS "await"), and fails if any `await`/`yield` keyword appears
 * in the remaining code. It also sanity-checks that the marked region still
 * contains the ledger read AND write, so the guard cannot rot into guarding an
 * empty or wrong region.
 *
 * Empirically validated: inserting `await Promise.resolve()` inside the region
 * makes this test fail (done during CAU-76 development, then reverted).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "in-memory.ts",
);

const BEGIN = "CLAIM-CRITICAL-SECTION-BEGIN";
const END = "CLAIM-CRITICAL-SECTION-END";

/** Count non-overlapping occurrences of `needle` in `haystack`. */
function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Strip `//` line comments and block comments. Deliberately naive (no
 * string-literal awareness): sufficient here because the critical section
 * contains no string literal with comment delimiters inside — and if one ever
 * appears, the failure mode is a FALSE POSITIVE (over-stripping cannot hide an
 * `await` that lives in real code on its own line; a comment delimiter inside
 * a string would at worst make the guard stricter, never blinder).
 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

describe("claim() critical-section guard (no await between ledger read and write)", () => {
  const source = readFileSync(SOURCE_PATH, "utf8");

  it("the marker pair exists exactly once (BEGIN before END)", () => {
    expect(count(source, BEGIN)).toBe(1);
    expect(count(source, END)).toBe(1);
    expect(source.indexOf(BEGIN)).toBeLessThan(source.indexOf(END));
  });

  it("the marked region still wraps the ledger read AND the ledger write", () => {
    const region = source.slice(
      source.indexOf(BEGIN),
      source.indexOf(END),
    );
    // If a refactor moves the compare-and-set out from between the markers,
    // the guard would be watching dead air — fail loudly instead.
    expect(region).toContain("claimLedger.get(");
    expect(region).toContain("claimLedger.set(");
  });

  it("contains no deferral in code between the markers", () => {
    const region = source.slice(
      source.indexOf(BEGIN),
      source.indexOf(END),
    );
    const code = stripComments(region);
    // Not just await/yield: anything that schedules work for a later tick
    // (.then, queueMicrotask, timers, nextTick, dynamic import) breaks the
    // run-to-completion property the same way.
    const offenders =
      code.match(
        /\b(await|yield)\b|\.then\s*\(|queueMicrotask|setTimeout|setImmediate|process\.nextTick|\bimport\s*\(/g,
      ) ?? [];
    expect(
      offenders,
      "a deferral (await/yield/.then/queueMicrotask/timer/nextTick/dynamic " +
        "import) entered the claim() ledger read→write critical section in " +
        "in-memory.ts — that breaks first-write-wins atomicity (the " +
        "read-then-write must be a single run-to-completion step; see " +
        "docs/BACKBONE_CONTRACT.md). Restructure so all deferrals happen " +
        "BEFORE the CLAIM-CRITICAL-SECTION-BEGIN marker.",
    ).toEqual([]);
  });
});
