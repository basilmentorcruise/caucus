/**
 * `caucus_fetch_artifact` — resolve a `caucus://` artifact URI to local bytes so
 * a finding's evidence can be re-run on this machine (ADR-C14, CAU-100).
 *
 * The other half of the cross-session/cross-machine evidence wedge: given the
 * `artifact` URI another session posted, this validates its shape, resolves it
 * against THIS session's OWN backbone wiring (never a caller-supplied host —
 * the SSRF guard by construction, ADR-C14), GETs the raw bytes, writes them to a
 * caller-named `path` (or a temp file), and returns the local path.
 *
 * SSRF guard, twice over:
 * - The URI must be a well-formed `caucus://artifact/<channel>/<sha256>`; any
 *   other scheme/host (`http://…`, a foreign authority) is REJECTED at parse —
 *   the tool can never be steered to dial an arbitrary host.
 * - The channel it names must be this session's home or a joined room (the
 *   session's join-gate); an unresolvable/foreign channel is rejected before any
 *   backbone call. The fetch always goes to the session's own validated
 *   `CAUCUS_URL`.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { z } from "zod";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import type { CaucusTool, ToolResult } from "./registry.js";
import { parseArtifactUri } from "./artifact-uri.js";

/** The input schema for `caucus_fetch_artifact`. */
const FETCH_ARTIFACT_INPUT = {
  uri: z
    .string()
    .min(1)
    .describe(
      "The caucus://artifact/<channel>/<sha256> URI to fetch — typically the " +
        "`artifact` value of a finding another session posted. Only caucus:// " +
        "artifact URIs are accepted; any other scheme/host is rejected.",
    ),
  path: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Absolute local path to write the fetched bytes to. Absent ⇒ a temp file " +
        "is created and its path returned.",
    ),
} as const satisfies ZodRawShapeCompat;

/** Parsed `caucus_fetch_artifact` args (validated by the SDK before `handle`). */
interface FetchArtifactArgs {
  readonly uri: string;
  readonly path?: string;
}

/**
 * Value-free (ADR-C12) tool-layer errors for the two reject paths. Neither
 * echoes the URI or any channel content — only the actionable rule.
 */
class ArtifactUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactUriError";
  }
}
class ArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactNotFoundError";
  }
}

/** The `caucus_fetch_artifact` tool. */
export const fetchArtifactTool: CaucusTool = {
  name: "caucus_fetch_artifact",
  description:
    "Fetch an artifact a teammate uploaded: resolve a caucus://artifact/... " +
    "URI (e.g. the `artifact` of a finding) to local bytes so you can re-run " +
    "the repro or inspect the evidence (ADR-C14). Writes to your `path` or a " +
    "temp file and returns the local path. Only caucus:// artifact URIs from a " +
    "room you're in (your channel or one you've joined) resolve — any other " +
    "scheme/host or an unjoined room is rejected. The store is ephemeral, so a " +
    "fetch fails once the source channel/backbone is gone.",
  inputSchema: FETCH_ARTIFACT_INPUT,
  async handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const { uri, path } = args as unknown as FetchArtifactArgs;
    // Shape guard / SSRF guard #1: only a well-formed caucus:// artifact URI is
    // accepted. A foreign scheme/host never parses, so it can't be dialed.
    const parsed = parseArtifactUri(uri);
    if (parsed === undefined) {
      throw new ArtifactUriError(
        "Not a valid caucus://artifact/<channel>/<sha256> URI. Only caucus:// " +
          "artifact URIs from a room you're in can be fetched.",
      );
    }
    // SSRF guard #2: the session resolves the channel against its OWN wiring and
    // enforces the join-gate — a foreign/unjoined channel throws NotJoinedError
    // (value-free) before any backbone call. The fetch goes to this session's
    // own CAUCUS_URL, never a caller-supplied host.
    const bytes = await session.fetchArtifact(parsed.channel, parsed.sha256);
    if (bytes === undefined) {
      // The channel resolved but holds no such blob (e.g. it expired with a
      // restart, or the address is wrong). Ephemeral store ⇒ this is expected.
      throw new ArtifactNotFoundError(
        "No artifact found at that URI — it may have expired (the store is " +
          "ephemeral) or the address is wrong.",
      );
    }
    // Write to the caller's path, or a fresh temp file. The local path we return
    // is caller-named or self-minted, so it is safe to surface (ADR-C12).
    let outPath: string;
    if (path !== undefined) {
      await writeFile(path, bytes);
      outPath = path;
    } else {
      const dir = await mkdtemp(join(tmpdir(), "caucus-artifact-"));
      outPath = join(dir, parsed.sha256);
      await writeFile(outPath, bytes);
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ path: outPath, size: bytes.length }),
        },
      ],
    };
  },
};
