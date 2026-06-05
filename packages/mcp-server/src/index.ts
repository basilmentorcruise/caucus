#!/usr/bin/env node
/**
 * @caucus/mcp-server — the Caucus MCP server entrypoint (CAU-9).
 *
 * Claude Code spawns this over stdio. This module is intentionally THIN: load
 * config from the environment, construct a backbone, build the server, and
 * attach the stdio transport. All testable behavior lives in `server.ts`,
 * `session.ts`, `identity.ts`, `config.ts`, and `tools/`.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { InMemoryBackbone } from "@caucus/backbone";
import { loadConfig } from "./config.js";
import { createCaucusServer } from "./server.js";
import { ensureChannel } from "./bootstrap.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // TODO(CAU-5/6): replace with HttpBackbone from @caucus/backbone-server once
  // merged. No HTTP backbone client exists yet, so the server runs against a
  // process-local InMemoryBackbone placeholder.
  const backbone = new InMemoryBackbone();
  // Ensure the session's channel exists before serving: a spawned server
  // otherwise has no `CAUCUS_CHANNEL` created, so every write would fail with
  // `unknown_channel` (CAU-10 validation gap). Idempotent — see ensureChannel.
  await ensureChannel(backbone, config);
  const server = createCaucusServer({ config, backbone });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  // This prints `String(err)` to stderr, so the CAU-13 credential loader must
  // never embed the raw token in a thrown error message (ADR-C12) — or it would
  // leak into the process's stderr on a startup failure.
  process.stderr.write(`caucus-mcp failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
