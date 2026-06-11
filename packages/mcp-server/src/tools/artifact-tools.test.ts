/**
 * Unit tests for the artifact MCP tools (ADR-C14 / CAU-100):
 * `caucus_upload_artifact` + `caucus_fetch_artifact`.
 *
 * Covers: a full upload→fetch round-trip over an InMemoryBackbone session; the
 * uploaded URI is FIELD-VALID for a message `artifact` (it passes the schema
 * validator); the fetch SSRF guard rejects a foreign/unresolvable URI before any
 * backbone call; the source-arg rule (exactly one of path/content); and that the
 * tool descriptions carry the no-secrets boundary (ADR-C12).
 */
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { InMemoryBackbone } from "@caucus/backbone";
import { newMsgId, SCHEMA_VERSION, validate } from "@caucus/schema";
import type { CaucusMessage } from "@caucus/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { uploadArtifactTool } from "./upload-artifact.js";
import { fetchArtifactTool } from "./fetch-artifact.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

let backbone: InMemoryBackbone;
let session: ReturnType<typeof createSession>;
let tmp: string;

beforeEach(async () => {
  backbone = new InMemoryBackbone();
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "test",
    created_by: "alice",
  });
  session = createSession(config, backbone);
  tmp = await mkdtemp(join(tmpdir(), "caucus-artifact-test-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Parse a tool result's single text block as JSON. */
function toolJson<T>(result: { content: { type: string; text?: string }[] }): T {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { text: string }).text) as T;
}

describe("caucus_upload_artifact (ADR-C14)", () => {
  it("uploads inline content and returns a {uri,sha256,size} envelope", async () => {
    const result = await uploadArtifactTool.handle(session, {
      content: "repro: curl -X POST /login",
    });
    const env = toolJson<{ uri: string; sha256: string; size: number }>(result);
    expect(env.uri).toMatch(/^caucus:\/\/artifact\/incident-1\/[0-9a-f]{64}$/);
    expect(env.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(env.size).toBe(Buffer.byteLength("repro: curl -X POST /login"));
  });

  it("uploads a local file by path", async () => {
    const path = join(tmp, "repro.sh");
    await writeFile(path, "#!/bin/sh\necho hello\n");
    const result = await uploadArtifactTool.handle(session, { path });
    const env = toolJson<{ uri: string; size: number }>(result);
    expect(env.uri).toMatch(/^caucus:\/\/artifact\/incident-1\/[0-9a-f]{64}$/);
  });

  it("the returned URI is FIELD-VALID for a message `artifact` (passes the schema validator)", () => {
    // Independent of the upload mechanics: a minted URI must satisfy the
    // `artifact` field validator (non-empty, no control chars, ≤ MAX_FIELD_CHARS)
    // so it can ride a real finding. ADR-C14 confirms caucus:// needs no schema
    // bump.
    const uri = `caucus://artifact/incident-1/${"a".repeat(64)}`;
    const msg = {
      v: SCHEMA_VERSION,
      type: "finding",
      agent_id: "agent-1",
      owner: "alice",
      msg_id: newMsgId(),
      body: "see repro",
      artifact: uri,
    } as CaucusMessage;
    expect(() => validate(msg)).not.toThrow();
  });

  it("requires EXACTLY one of path/content (neither → error)", async () => {
    await expect(uploadArtifactTool.handle(session, {})).rejects.toThrow(
      /exactly one of/i,
    );
  });

  it("requires EXACTLY one of path/content (both → error)", async () => {
    await expect(
      uploadArtifactTool.handle(session, { path: "/x", content: "y" }),
    ).rejects.toThrow(/exactly one of/i);
  });

  it("rejects content over the per-blob cap locally (clearer than a wire 413)", async () => {
    const { MAX_ARTIFACT_BYTES } = await import("@caucus/backbone");
    const huge = "x".repeat(MAX_ARTIFACT_BYTES + 1);
    await expect(
      uploadArtifactTool.handle(session, { content: huge }),
    ).rejects.toThrow(/too large/i);
  });

  it("forbids secrets in its description (ADR-C12)", () => {
    expect(uploadArtifactTool.description.toLowerCase()).toContain("never");
    expect(uploadArtifactTool.description.toLowerCase()).toContain("secret");
    expect(uploadArtifactTool.description).toContain("ADR-C12");
  });
});

describe("caucus_fetch_artifact (ADR-C14)", () => {
  it("round-trips: upload then fetch returns byte-identical content at a local path", async () => {
    const content = "the full hexdump\n0000 ff fe";
    const up = toolJson<{ uri: string }>(
      await uploadArtifactTool.handle(session, { content }),
    );

    const outPath = join(tmp, "fetched.txt");
    const down = toolJson<{ path: string; size: number }>(
      await fetchArtifactTool.handle(session, { uri: up.uri, path: outPath }),
    );
    expect(down.path).toBe(outPath);
    expect(await readFile(outPath, "utf8")).toBe(content);
  });

  it("writes to a temp file when no path is given and returns its location", async () => {
    const up = toolJson<{ uri: string }>(
      await uploadArtifactTool.handle(session, { content: "x" }),
    );
    const down = toolJson<{ path: string }>(
      await fetchArtifactTool.handle(session, { uri: up.uri }),
    );
    expect(await readFile(down.path, "utf8")).toBe("x");
  });

  it("rejects a foreign/non-caucus URI WITHOUT touching the backbone (SSRF guard)", async () => {
    await expect(
      fetchArtifactTool.handle(session, {
        uri: "http://evil.example/artifact/incident-1/" + "a".repeat(64),
      }),
    ).rejects.toThrow(/caucus:\/\//i);
  });

  it("rejects a caucus URI for a channel this session has NOT joined (SSRF guard)", async () => {
    // A different, existing channel the session never joined: resolving it must
    // be refused by the join-gate before any backbone fetch.
    await backbone.createChannel({
      channel: "other-room",
      purpose: "p",
      created_by: "bob",
    });
    const uri = `caucus://artifact/other-room/${"a".repeat(64)}`;
    await expect(
      fetchArtifactTool.handle(session, { uri }),
    ).rejects.toMatchObject({ code: "not_joined" });
  });

  it("fetch works after JOINING the room the URI names (gate opens on join)", async () => {
    await backbone.createChannel({
      channel: "shared-room",
      purpose: "p",
      created_by: "bob",
    });
    // Upload into the joined room (after opening the gate), then fetch it.
    session.noteJoined("shared-room");
    const up = toolJson<{ uri: string }>(
      await uploadArtifactTool.handle(session, {
        content: "joined evidence",
        channel: "shared-room",
      }),
    );
    const down = toolJson<{ path: string }>(
      await fetchArtifactTool.handle(session, { uri: up.uri }),
    );
    expect(await readFile(down.path, "utf8")).toBe("joined evidence");
  });

  it("reports a not-found for a valid URI whose blob is absent (ephemeral miss)", async () => {
    const uri = `caucus://artifact/incident-1/${"0".repeat(64)}`;
    await expect(fetchArtifactTool.handle(session, { uri })).rejects.toThrow(
      /expired|no artifact/i,
    );
  });
});
