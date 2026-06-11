/**
 * Unit tests for the artifact URI mint/parse seam (ADR-C14 / CAU-100): the
 * caucus:// round-trip and the strict, host-free shape guard that is the first
 * line of the SSRF defense (a foreign scheme/host never parses).
 */
import { describe, expect, it } from "vitest";

import { mintArtifactUri, parseArtifactUri } from "./artifact-uri.js";

const SHA = "a".repeat(64);

describe("artifact-uri — mint/parse round-trip (ADR-C14)", () => {
  it("mints caucus://artifact/<channel>/<sha256> and parses it back", () => {
    const uri = mintArtifactUri("incident-1", SHA);
    expect(uri).toBe(`caucus://artifact/incident-1/${SHA}`);
    expect(parseArtifactUri(uri)).toEqual({
      channel: "incident-1",
      sha256: SHA,
    });
  });

  it("rejects a foreign scheme / host (SSRF guard #1)", () => {
    expect(parseArtifactUri(`http://evil.example/artifact/c/${SHA}`)).toBeUndefined();
    expect(parseArtifactUri(`https://x/${SHA}`)).toBeUndefined();
    // A caucus:// URI that is NOT an /artifact/ one is rejected.
    expect(parseArtifactUri(`caucus://channel/incident-1`)).toBeUndefined();
    // An authority/host smuggled into the artifact path is rejected (the slug
    // grammar admits no `@`, `:`, or `.`).
    expect(
      parseArtifactUri(`caucus://artifact/evil.host@x/${SHA}`),
    ).toBeUndefined();
  });

  it("rejects a malformed channel or sha256", () => {
    expect(parseArtifactUri(`caucus://artifact/BAD SLUG/${SHA}`)).toBeUndefined();
    expect(parseArtifactUri(`caucus://artifact/c/not-a-sha`)).toBeUndefined();
    expect(parseArtifactUri(`caucus://artifact/c/${"A".repeat(64)}`)).toBeUndefined(); // uppercase
    expect(parseArtifactUri(`caucus://artifact/c/${SHA}/extra`)).toBeUndefined();
    expect(parseArtifactUri("caucus://artifact/c")).toBeUndefined(); // no sha
    expect(parseArtifactUri("not a uri at all")).toBeUndefined();
    expect(parseArtifactUri("")).toBeUndefined();
  });
});
