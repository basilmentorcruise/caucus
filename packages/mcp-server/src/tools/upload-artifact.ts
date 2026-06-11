/**
 * `caucus_upload_artifact` — upload a repro/evidence blob to a channel's
 * ephemeral evidence store and get back a `caucus://` URI for the `artifact`
 * field (ADR-C14, CAU-100).
 *
 * The investigation wedge this unblocks (CAU-85 friction #3): a finding's repro
 * script / hexdump / log can travel WITH the finding so another session on
 * another machine fetches and re-runs it, instead of leaving it unshareable in
 * `/tmp`. The tool reads a local `path` OR inline `content`, computes the
 * SHA-256, PUTs the raw bytes through the session (token-gated, content-verified
 * server-side), and returns `{uri, sha256, size}` — drop `uri` into
 * `caucus_post_finding`'s `artifact` argument.
 *
 * Bounds + hygiene (ADR-C14 / ADR-C12):
 * - Exactly ONE of `path` / `content` is required (both/neither ⇒ a clean,
 *   value-free error).
 * - The store is EPHEMERAL (channel = process lifetime) — not durable archival.
 * - The blob is the SAME shared-log leak surface as a message body: NEVER upload
 *   secrets, tokens, or customer data. The bytes are opaque and never rendered
 *   (the hook shows only a `↗artifact` marker).
 * - Routing reuses the CAU-92 join-gate: an optional `channel` targets a room
 *   OTHER than home, and the session rejects a not-joined target before the
 *   backbone is touched.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { z } from "zod";
import { MAX_ARTIFACT_BYTES } from "@caucus/backbone";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { CaucusTool, ToolResult } from "./registry.js";

/** The input schema for `caucus_upload_artifact`. */
const UPLOAD_ARTIFACT_INPUT = {
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute path to a local file to upload (e.g. a repro script, hexdump, " +
        "or log). Provide EITHER `path` OR `content`, not both. NEVER upload " +
        "secrets, tokens, or customer data — the store is a shared, ephemeral " +
        "log (ADR-C12).",
    ),
  content: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Inline UTF-8 text to upload as the artifact, when you don't have it as " +
        "a file. Provide EITHER `content` OR `path`, not both. No secrets " +
        "(ADR-C12).",
    ),
  channel: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Target room for the upload. Absent ⇒ your session channel. To upload " +
        "into another room you must have joined it first with " +
        "caucus_join_channel.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_upload_artifact` args (validated by the SDK before `handle`). */
interface UploadArtifactArgs {
  readonly path?: string;
  readonly content?: string;
  readonly channel?: string;
}

/**
 * Thrown when neither / both of `path` and `content` are supplied. A value-free
 * (ADR-C12) tool-layer error: it states the rule, never the offending values.
 * Surfaced to the model as `isError` text by the SDK.
 */
class ArtifactSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactSourceError";
  }
}

/** The `caucus_upload_artifact` tool. */
export const uploadArtifactTool: CaucusTool = {
  name: "caucus_upload_artifact",
  description:
    "Upload a repro/evidence blob (a local file `path` OR inline `content`) to " +
    "the channel's EPHEMERAL evidence store and get back a caucus:// URI for " +
    "the `artifact` field of a finding (ADR-C14). Use it so a finding's " +
    "evidence — a repro script, hexdump, or log — travels with it and another " +
    "session/machine can fetch and re-run it (caucus_fetch_artifact). The store " +
    "lives only as long as the channel (not durable archival). Provide EXACTLY " +
    "one of `path`/`content`. NEVER upload secrets, tokens, or customer data — " +
    "the store is a shared log under the same boundary as a post (ADR-C12). " +
    "Returns {uri, sha256, size}.",
  inputSchema: UPLOAD_ARTIFACT_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { path, content, channel } = args as unknown as UploadArtifactArgs;
    // Exactly one source. Both/neither is a usage error, value-free.
    if ((path === undefined) === (content === undefined)) {
      throw new ArtifactSourceError(
        "Provide exactly one of `path` or `content` (not both, not neither).",
      );
    }
    // Read the bytes. A file read failure (missing/unreadable path) propagates
    // as the SDK's isError text; Node's ENOENT message names the path the CALLER
    // supplied (its own local path), not channel content, so it is safe to
    // surface and actionable.
    const bytes =
      path !== undefined
        ? new Uint8Array(await readFile(path))
        : new Uint8Array(Buffer.from(content as string, "utf8"));
    // Pre-check the per-blob cap locally for a clearer error than a wire 413
    // (the backbone re-checks authoritatively). Value-free.
    if (bytes.length > MAX_ARTIFACT_BYTES) {
      throw new ArtifactSourceError(
        `Artifact too large: at most ${MAX_ARTIFACT_BYTES} bytes per upload.`,
      );
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    // The session enforces the join-gate (CAU-92) and PUTs the raw bytes; the
    // server verifies sha256(body) and mints the URI. The returned `uri` is
    // field-valid for `artifact` (caucus://, no control chars, well under
    // MAX_FIELD_CHARS).
    const result = await session.uploadArtifact(sha256, bytes, channel);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            uri: result.uri,
            sha256: result.sha256,
            size: result.size,
          }),
        },
      ],
    };
  },
};
