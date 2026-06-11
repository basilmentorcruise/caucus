/**
 * Behavioral tests for the ephemeral evidence store (ADR-C14 / CAU-100):
 * content-addressed put/get on `InMemoryBackbone`. Covers sha-verify
 * happy/mismatch, dedup + idempotency, each of the three byte caps at its
 * boundary, unknown-channel put/get, and running-total accounting across
 * put + dedup.
 */
import { createHash } from "node:crypto";

import { describe, expect, it, beforeEach } from "vitest";

import {
  ArtifactIntegrityError,
  ArtifactTooLargeError,
  InMemoryBackbone,
  InvalidChannelNameError,
  MAX_ARTIFACT_BYTES,
  MAX_CHANNEL_ARTIFACT_BYTES,
  MAX_TOTAL_ARTIFACT_BYTES,
  UnknownChannelError,
} from "./index.js";

const CH = "incident-1";

let b: InMemoryBackbone;

beforeEach(async () => {
  b = new InMemoryBackbone();
  await b.createChannel({ channel: CH, purpose: "evidence", created_by: "alice" });
});

/** Lowercase-hex SHA-256 of `bytes`. */
function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A deterministic byte buffer of length `n` filled with `fill`. */
function bytesOf(n: number, fill = 0): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

describe("InMemoryBackbone artifact store — sha verify (ADR-C14)", () => {
  it("stores a blob addressed by its own sha256 and reads it back byte-identical", async () => {
    const bytes = new Uint8Array(Buffer.from("repro script v1", "utf8"));
    const digest = sha(bytes);

    const result = await b.putArtifact(CH, digest, bytes);
    expect(result.sha256).toBe(digest);
    expect(result.size).toBe(bytes.length);
    expect(result.deduplicated).toBe(false);
    expect(result.uri).toBe(`caucus://artifact/${CH}/${digest}`);

    const got = await b.getArtifact(CH, digest);
    expect(got).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(got as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it("rejects bytes that do not hash to the supplied address (integrity mismatch)", async () => {
    const bytes = new Uint8Array(Buffer.from("evidence", "utf8"));
    const wrong = sha(new Uint8Array(Buffer.from("something else", "utf8")));
    await expect(b.putArtifact(CH, wrong, bytes)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
    // Nothing was stored.
    expect(await b.getArtifact(CH, wrong)).toBeUndefined();
    expect(await b.getArtifact(CH, sha(bytes))).toBeUndefined();
  });

  it("rejects a malformed (non-hex / wrong-length) content address as an integrity fault", async () => {
    const bytes = bytesOf(8);
    await expect(b.putArtifact(CH, "not-a-sha", bytes)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
    await expect(
      b.putArtifact(CH, "A".repeat(64), bytes),
    ).rejects.toBeInstanceOf(ArtifactIntegrityError); // uppercase hex rejected
  });
});

describe("InMemoryBackbone artifact store — dedup + idempotency (ADR-C14)", () => {
  it("storing identical bytes twice stores once and returns deduplicated on the second", async () => {
    const bytes = new Uint8Array(Buffer.from("same bytes", "utf8"));
    const digest = sha(bytes);

    const first = await b.putArtifact(CH, digest, bytes);
    expect(first.deduplicated).toBe(false);

    const second = await b.putArtifact(CH, digest, bytes);
    expect(second.deduplicated).toBe(true);
    expect(second.uri).toBe(first.uri);
    expect(second.size).toBe(first.size);

    // Still exactly one blob, byte-identical.
    const got = await b.getArtifact(CH, digest);
    expect(Buffer.from(got as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a stored blob is independent of the caller's buffer (mutating after put does not change the store)", async () => {
    const bytes = new Uint8Array(Buffer.from("frozen", "utf8"));
    const digest = sha(bytes);
    await b.putArtifact(CH, digest, bytes);
    bytes[0] = 0xff; // mutate caller's buffer
    const got = await b.getArtifact(CH, digest);
    expect(got?.[0]).toBe("frozen".charCodeAt(0));
  });
});

describe("InMemoryBackbone artifact store — the three caps (ADR-C14)", () => {
  it("rejects a single blob over the per-blob cap (MAX_ARTIFACT_BYTES)", async () => {
    const bytes = bytesOf(MAX_ARTIFACT_BYTES + 1);
    const digest = sha(bytes);
    let thrown: unknown;
    await b.putArtifact(CH, digest, bytes).catch((e) => (thrown = e));
    expect(thrown).toBeInstanceOf(ArtifactTooLargeError);
    expect((thrown as ArtifactTooLargeError).scope).toBe("blob");
  });

  it("rejects once a channel's running total would exceed the per-channel cap", async () => {
    // Fill the channel to just under the per-channel cap with max-sized blobs,
    // each distinct (a different fill byte ⇒ a different sha), then one more that
    // tips it over.
    const blobSize = MAX_ARTIFACT_BYTES;
    const count = MAX_CHANNEL_ARTIFACT_BYTES / blobSize; // 16 exactly
    for (let i = 0; i < count; i++) {
      const bytes = bytesOf(blobSize, i);
      await b.putArtifact(CH, sha(bytes), bytes);
    }
    const over = bytesOf(1, 99);
    let thrown: unknown;
    await b.putArtifact(CH, sha(over), over).catch((e) => (thrown = e));
    expect(thrown).toBeInstanceOf(ArtifactTooLargeError);
    expect((thrown as ArtifactTooLargeError).scope).toBe("channel");
  });

  it("rejects once the backbone-wide running total would exceed the global cap", async () => {
    // Spread max-sized blobs across enough channels to reach the global cap,
    // staying under the per-channel cap in each, then one more blob tips global.
    const blobSize = MAX_ARTIFACT_BYTES;
    const perChannel = MAX_CHANNEL_ARTIFACT_BYTES / blobSize; // 16
    const channels = MAX_TOTAL_ARTIFACT_BYTES / MAX_CHANNEL_ARTIFACT_BYTES; // 8
    let fill = 0;
    for (let c = 0; c < channels; c++) {
      const name = `chan-${c}`;
      await b.createChannel({ channel: name, purpose: "p", created_by: "alice" });
      for (let i = 0; i < perChannel; i++) {
        const bytes = bytesOf(blobSize, fill++ % 256);
        await b.putArtifact(name, sha(bytes), bytes);
      }
    }
    // A fresh channel with room per-channel, but the global budget is exhausted.
    await b.createChannel({ channel: "spill", purpose: "p", created_by: "alice" });
    const over = bytesOf(1, 200);
    let thrown: unknown;
    await b.putArtifact("spill", sha(over), over).catch((e) => (thrown = e));
    expect(thrown).toBeInstanceOf(ArtifactTooLargeError);
    expect((thrown as ArtifactTooLargeError).scope).toBe("global");
  });
});

describe("InMemoryBackbone artifact store — unknown channel + accounting", () => {
  it("put against an unknown channel throws UnknownChannelError", async () => {
    const bytes = bytesOf(4);
    await expect(
      b.putArtifact("no-such-room", sha(bytes), bytes),
    ).rejects.toBeInstanceOf(UnknownChannelError);
  });

  it("get against an unknown channel throws UnknownChannelError", async () => {
    await expect(
      b.getArtifact("no-such-room", "0".repeat(64)),
    ).rejects.toBeInstanceOf(UnknownChannelError);
  });

  it("get of a known channel with no such blob returns undefined", async () => {
    expect(await b.getArtifact(CH, "0".repeat(64))).toBeUndefined();
  });

  it("an invalid channel slug is rejected on put and get", async () => {
    const bytes = bytesOf(4);
    await expect(
      b.putArtifact("BAD SLUG", sha(bytes), bytes),
    ).rejects.toBeInstanceOf(InvalidChannelNameError);
    await expect(
      b.getArtifact("BAD SLUG", "0".repeat(64)),
    ).rejects.toBeInstanceOf(InvalidChannelNameError);
  });

  it("dedup does NOT re-charge the byte budgets (running totals advance once)", async () => {
    // Store two DISTINCT max-sized blobs (32 used of the 16 MiB channel cap), then
    // re-store one (dedup). A third distinct max-sized blob must still fit; the
    // channel cap is 16 MiB so up to 16 max-sized blobs fit. If dedup had
    // re-charged, the running total would be wrong but still admit — so instead we
    // assert dedup returns idempotently AND a re-store of identical bytes never
    // throws a cap error even when near the boundary.
    const blobSize = MAX_ARTIFACT_BYTES;
    const a = bytesOf(blobSize, 1);
    const c = bytesOf(blobSize, 2);
    await b.putArtifact(CH, sha(a), a); // fill 1
    await b.putArtifact(CH, sha(c), c); // fill 2
    // Fill the rest of the channel cap: 14 more distinct max-sized blobs (fills
    // 3..16) ⇒ 16 total ⇒ exactly MAX_CHANNEL_ARTIFACT_BYTES.
    for (let i = 3; i <= 16; i++) {
      const bytes = bytesOf(blobSize, i);
      await b.putArtifact(CH, sha(bytes), bytes);
    }
    // Channel is now exactly at its cap. Re-storing an EXISTING blob must succeed
    // (dedup, no re-charge) even though there is no headroom for a new one.
    const redup = await b.putArtifact(CH, sha(a), a);
    expect(redup.deduplicated).toBe(true);
    // A NEW distinct blob is rejected (channel full) — proving the total is
    // exactly at the cap, i.e. dedup never double-counted.
    const fresh = bytesOf(1, 200);
    await expect(b.putArtifact(CH, sha(fresh), fresh)).rejects.toBeInstanceOf(
      ArtifactTooLargeError,
    );
  });
});
