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

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  // TODO(CAU-5/6): replace with HttpBackbone from @caucus/backbone-server once
  // merged. No HTTP backbone client exists yet, so the server runs against a
  // process-local InMemoryBackbone placeholder.
  const backbone = new InMemoryBackbone();
  const server = createCaucusServer({ config, backbone });
  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  process.stderr.write(`caucus-mcp failed to start: ${String(err)}\n`);
  process.exitCode = 1;
});
