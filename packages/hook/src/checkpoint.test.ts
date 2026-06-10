import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  checkpointDir,
  checkpointPath,
  readCheckpoint,
  readLastInjection,
  writeCheckpoint,
} from "./checkpoint.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "caucus-hook-cp-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe("checkpointPath / checkpointDir", () => {
  it("keys by sessionId and channel under ~/.caucus/checkpoints", () => {
    const p = checkpointPath("sess-1", "incident-42", home);
    expect(p).toBe(join(checkpointDir(home), "sess-1__incident-42.json"));
  });

  it("sanitizes path separators in both key parts (no traversal)", () => {
    const p = checkpointPath("../../etc/passwd", "a/b\\c", home);
    const dir = checkpointDir(home);
    expect(p.startsWith(dir + "/")).toBe(true);
    const file = p.slice(dir.length + 1);
    expect(file).not.toContain("/");
    expect(file).not.toContain("\\");
    expect(file).not.toContain("..");
  });

  it("distinct channels in one session get distinct files", () => {
    const a = checkpointPath("s", "chan-a", home);
    const b = checkpointPath("s", "chan-b", home);
    expect(a).not.toBe(b);
  });
});

describe("writeCheckpoint / readCheckpoint round-trip", () => {
  it("writes then reads back the cursor for the matching channel", async () => {
    const p = checkpointPath("s", "incident-42", home);
    await writeCheckpoint(p, 7, "incident-42");
    expect(await readCheckpoint(p, "incident-42")).toBe(7);
  });

  it("persists the documented {cursor,channel,v} format (v1, no injection)", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 3, "c");
    const raw = JSON.parse(await readFile(p, "utf8"));
    // Omitting lastInjection writes only the cursor envelope at v1.
    expect(raw).toEqual({ cursor: 3, channel: "c", v: 1 });
  });

  it("creates the checkpoints directory if absent (mkdir -p)", async () => {
    const p = checkpointPath("fresh", "brand-new", home);
    await expect(writeCheckpoint(p, 0, "brand-new")).resolves.toBeUndefined();
    expect(await readCheckpoint(p, "brand-new")).toBe(0);
  });

  it("writes atomically (no leftover temp file)", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 5, "c");
    // The temp file is renamed away; only the final file remains.
    await expect(readFile(`${p}.${process.pid}.tmp`, "utf8")).rejects.toThrow();
  });
});

describe("readCheckpoint → undefined on every unusable case", () => {
  it("returns undefined for a missing file", async () => {
    const p = checkpointPath("nope", "c", home);
    expect(await readCheckpoint(p, "c")).toBeUndefined();
  });

  it("returns undefined for corrupt JSON", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c"); // ensures dir exists
    await writeFile(p, "{not json", "utf8");
    expect(await readCheckpoint(p, "c")).toBeUndefined();
  });

  it("returns undefined on channel mismatch", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 4, "c");
    expect(await readCheckpoint(p, "different-channel")).toBeUndefined();
  });

  it("returns undefined for a non-integer cursor", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c");
    await writeFile(p, JSON.stringify({ cursor: 1.5, channel: "c", v: 0 }), "utf8");
    expect(await readCheckpoint(p, "c")).toBeUndefined();
  });

  it("returns undefined for a negative cursor", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c");
    await writeFile(p, JSON.stringify({ cursor: -1, channel: "c", v: 0 }), "utf8");
    expect(await readCheckpoint(p, "c")).toBeUndefined();
  });

  it("returns undefined for a non-numeric cursor", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c");
    await writeFile(p, JSON.stringify({ cursor: "5", channel: "c", v: 0 }), "utf8");
    expect(await readCheckpoint(p, "c")).toBeUndefined();
  });

  it("returns undefined for a non-object JSON body", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c");
    await writeFile(p, "42", "utf8");
    expect(await readCheckpoint(p, "c")).toBeUndefined();
  });

  it("returns undefined for a JSON null body", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c");
    await writeFile(p, "null", "utf8");
    expect(await readCheckpoint(p, "c")).toBeUndefined();
  });

  it("accepts cursor 0 (a freshly minted at-head checkpoint)", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 0, "c");
    expect(await readCheckpoint(p, "c")).toBe(0);
  });
});

describe("lastInjection v1 round-trip + v0 backward compat (CAU-93)", () => {
  it("round-trips a lastInjection record at v1", async () => {
    const p = checkpointPath("s", "c", home);
    const li = { cursor: 9, block: "=== CAUCUS ===\nbody\n=== END ===", ts: "2026-06-10T00:00:00.000Z" };
    await writeCheckpoint(p, 9, "c", li);
    // The cursor still reads back…
    expect(await readCheckpoint(p, "c")).toBe(9);
    // …and the exact injection block is recovered byte-for-byte.
    expect(await readLastInjection(p, "c")).toEqual(li);
    const raw = JSON.parse(await readFile(p, "utf8"));
    expect(raw.v).toBe(1);
    expect(raw.lastInjection).toEqual(li);
  });

  it("a v0 file (no lastInjection) still yields a valid cursor, injection undefined", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 0, "c"); // ensure the checkpoints dir exists
    // Simulate a checkpoint written by the previous (v0) hook.
    await writeFile(p, JSON.stringify({ cursor: 11, channel: "c", v: 0 }), "utf8");
    expect(await readCheckpoint(p, "c")).toBe(11);
    expect(await readLastInjection(p, "c")).toBeUndefined();
  });

  it("readLastInjection → undefined on corrupt / missing files", async () => {
    const missing = checkpointPath("nope", "c", home);
    expect(await readLastInjection(missing, "c")).toBeUndefined();

    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c"); // ensure dir
    await writeFile(p, "{not json", "utf8");
    expect(await readLastInjection(p, "c")).toBeUndefined();
  });

  it("readLastInjection → undefined on channel mismatch", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c", { cursor: 1, block: "x", ts: "t" });
    expect(await readLastInjection(p, "other")).toBeUndefined();
  });

  it("readLastInjection → undefined on a malformed lastInjection record", async () => {
    const p = checkpointPath("s", "c", home);
    await writeCheckpoint(p, 1, "c"); // ensure dir
    // Non-string block, non-integer cursor, missing ts — each is rejected.
    for (const bad of [
      { cursor: 1.5, block: "x", ts: "t" },
      { cursor: 1, block: 42, ts: "t" },
      { cursor: 1, block: "x" },
      { cursor: -1, block: "x", ts: "t" },
      "not-an-object",
    ]) {
      await writeFile(
        p,
        JSON.stringify({ cursor: 1, channel: "c", v: 1, lastInjection: bad }),
        "utf8",
      );
      // The cursor remains usable even when the injection record is junk.
      expect(await readCheckpoint(p, "c")).toBe(1);
      expect(await readLastInjection(p, "c")).toBeUndefined();
    }
  });
});
