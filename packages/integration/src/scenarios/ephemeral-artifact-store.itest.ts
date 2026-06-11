/**
 * Integration scenario — the shared ephemeral evidence store (ADR-C14 / CAU-100)
 * end-to-end over a REAL backbone-server process.
 *
 * The four ACs the issue calls out, validated against the wire (not in-process):
 *
 * 1. **Cross-session / cross-machine** — client A (one HttpBackbone "wiring")
 *    uploads a blob and posts a finding carrying its caucus:// URI; client B (a
 *    SEPARATE HttpBackbone, distinct token — modelling another machine) fetches
 *    it and gets byte-identical content whose sha256 matches.
 * 2. **Teardown** — after an upload + a confirmed fetch, the server process is
 *    torn down and restarted; the same fetch now 404s and nothing persisted to
 *    disk (the store is in-memory, process-lifetime).
 * 3. **Size cap** — a PUT over MAX_ARTIFACT_BYTES → 413; filling a channel past
 *    its per-channel total → 413.
 * 4. **Leak surface** — a finding whose `artifact` is a blob URI renders only
 *    `↗artifact` in the hook delta (no URI, no bytes), and the GET serves
 *    `application/octet-stream`.
 *
 * It spawns the backbone-server bin as its own process (so teardown is a real
 * process exit) and the hook bin exactly as Claude Code drives it. The bins are
 * built once by the integration globalSetup.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ArtifactTooLargeError,
  MAX_ARTIFACT_BYTES,
  MAX_CHANNEL_ARTIFACT_BYTES,
} from "@caucus/backbone";
import { HttpBackbone } from "@caucus/backbone-server";
import { newMsgId } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServerProcess, type ServerProcess } from "../harness.js";

const REPO_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);
const HOOK_BIN = join(REPO_ROOT, "packages", "hook", "dist", "bin.js");

const CHANNEL = "incident-evidence";

// The MVP token convention (see shared-backbone.itest): an opaque colon-free
// bearer; the server map entry is `<secret>:<agent>:<owner>`. Two sessions ⇒ two
// secrets, modelling two machines.
const TOK_A = "tok-alice-secret";
const TOK_B = "tok-bob-secret";
const SERVER_TOKENS = `${TOK_A}:alice-agent:alice,${TOK_B}:bob-agent:bob`;

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A child env: process.env (undefined stripped) plus overrides. */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...overrides };
}

/** Run the hook bin as Claude Code would and return its parsed additionalContext. */
function runHookContext(home: string, url: string, sessionId: string): string {
  const stdout = execFileSync("node", [HOOK_BIN], {
    cwd: REPO_ROOT,
    env: childEnv({
      HOME: home,
      USERPROFILE: home,
      CAUCUS_URL: url,
      CAUCUS_CHANNEL: CHANNEL,
    }),
    input: JSON.stringify({ session_id: sessionId, hook_event_name: "UserPromptSubmit" }),
    encoding: "utf8",
  });
  if (stdout.trim() === "") return "";
  const parsed = JSON.parse(stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? "";
}

describe("ephemeral artifact store over the wire (ADR-C14 / CAU-100)", () => {
  let server: ServerProcess;
  let url: string;
  let a: HttpBackbone;
  let b: HttpBackbone;
  let home: string;

  beforeAll(async () => {
    server = await startServerProcess({ CAUCUS_TOKENS: SERVER_TOKENS });
    url = server.url;
    a = new HttpBackbone(url, { token: TOK_A });
    b = new HttpBackbone(url, { token: TOK_B });
    await a.createChannel({ channel: CHANNEL, purpose: "evidence", created_by: "alice" });
    home = await mkdtemp(join(tmpdir(), "caucus-artifact-itest-"));
  });

  afterAll(async () => {
    await server?.stop();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  it("AC1: cross-session — A uploads + posts the URI; B fetches byte-identical content", async () => {
    const bytes = new Uint8Array(Buffer.from("#!/bin/sh\ncurl -X POST /login --data @jwt\n", "utf8"));
    const digest = sha(bytes);

    // A uploads (token-gated) and posts a finding carrying the logical URI.
    const put = await a.putArtifact(CHANNEL, digest, bytes);
    expect(put.uri).toBe(`caucus://artifact/${CHANNEL}/${digest}`);
    await a.append(CHANNEL, {
      type: "finding",
      agent_id: "alice-agent",
      owner: "alice",
      msg_id: newMsgId(),
      body: "login accepts expired JWTs — repro attached",
      artifact: put.uri,
    });

    // B — a SEPARATE wiring (different token) modelling another machine — reads
    // the finding, recovers the URI, and fetches the blob.
    const { messages } = await b.readSince(CHANNEL, 0);
    const found = messages.find((m) => m.artifact === put.uri);
    expect(found).toBeDefined();
    const fetched = await b.getArtifact(CHANNEL, digest);
    expect(fetched).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(fetched as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
    // The content address still matches what B fetched (integrity end-to-end).
    expect(sha(fetched as Uint8Array)).toBe(digest);
  });

  it("AC4: leak surface — the hook renders only ↗artifact (no URI/bytes); GET is octet-stream", async () => {
    // Pre-mint the hook checkpoint at head BEFORE the artifact finding, so the
    // run sees a genuine delta (ADR-C6: no backlog replay on first run).
    const session = "sess-artifact-leak";
    expect(runHookContext(home, url, session)).toBe("");

    const bytes = new Uint8Array(Buffer.from("SENSITIVE-LOOKING-EVIDENCE-BYTES", "utf8"));
    const digest = sha(bytes);
    const put = await a.putArtifact(CHANNEL, digest, bytes);
    await a.append(CHANNEL, {
      type: "finding",
      agent_id: "alice-agent",
      owner: "alice",
      msg_id: newMsgId(),
      body: "evidence uploaded",
      artifact: put.uri,
    });

    const ctx = runHookContext(home, url, session);
    // The marker is present...
    expect(ctx).toContain("↗artifact");
    // ...but NEITHER the URI nor the blob bytes are ever rendered (ADR-C12).
    expect(ctx).not.toContain(put.uri);
    expect(ctx).not.toContain(digest);
    expect(ctx).not.toContain("SENSITIVE-LOOKING-EVIDENCE-BYTES");

    // The GET serves opaque application/octet-stream (raw fetch, tokenless).
    const res = await fetch(`${url}/channels/${CHANNEL}/artifacts/${digest}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("AC3: size caps — a >1MiB blob → 413; filling a channel past its total → 413", async () => {
    // Per-blob cap: one byte over MAX_ARTIFACT_BYTES is rejected 413
    // (reconstructed as ArtifactTooLargeError scope "blob").
    const tooBig = new Uint8Array(MAX_ARTIFACT_BYTES + 1).fill(1);
    let thrown: unknown;
    await a.putArtifact(CHANNEL, sha(tooBig), tooBig).catch((e) => (thrown = e));
    expect(thrown).toBeInstanceOf(ArtifactTooLargeError);
    expect((thrown as ArtifactTooLargeError).scope).toBe("blob");

    // Per-channel cap: fill a FRESH channel with max-sized distinct blobs to its
    // 16 MiB total, then one more byte → 413 (scope "channel").
    const capChannel = "incident-capfill";
    await a.createChannel({ channel: capChannel, purpose: "p", created_by: "alice" });
    const count = MAX_CHANNEL_ARTIFACT_BYTES / MAX_ARTIFACT_BYTES; // 16
    for (let i = 0; i < count; i++) {
      const blob = new Uint8Array(MAX_ARTIFACT_BYTES).fill(i);
      await a.putArtifact(capChannel, sha(blob), blob);
    }
    const over = new Uint8Array(1).fill(200);
    let capThrown: unknown;
    await a.putArtifact(capChannel, sha(over), over).catch((e) => (capThrown = e));
    expect(capThrown).toBeInstanceOf(ArtifactTooLargeError);
    expect((capThrown as ArtifactTooLargeError).scope).toBe("channel");
  });

  it("AC2: teardown — fetch works, then a restarted server 404s (nothing persisted)", async () => {
    const bytes = new Uint8Array(Buffer.from("ephemeral evidence", "utf8"));
    const digest = sha(bytes);
    await a.putArtifact(CHANNEL, digest, bytes);
    // Confirmed reachable before teardown.
    expect(await a.getArtifact(CHANNEL, digest)).toBeDefined();

    // Tear the server down (a real process exit) and start a FRESH one on a new
    // ephemeral port — the in-memory store is gone, nothing on disk.
    await server.stop();
    server = await startServerProcess({ CAUCUS_TOKENS: SERVER_TOKENS });
    url = server.url;
    const fresh = new HttpBackbone(url, { token: TOK_A });

    // The channel itself no longer exists ⇒ the artifact GET is a 404 (the
    // HttpBackbone maps a 404 to undefined). The store did not survive the exit.
    const got = await fresh.getArtifact(CHANNEL, digest).catch(() => undefined);
    expect(got).toBeUndefined();
  });
});
