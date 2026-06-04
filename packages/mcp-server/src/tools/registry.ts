/**
 * Tool-registration mechanics (CAU-9).
 *
 * Caucus tools are described by the transport-agnostic {@link CaucusTool}
 * interface; {@link registerTools} is the single adapter that maps them onto the
 * MCP SDK's `registerTool`. All SDK-specific shape (the `registerTool` config
 * object, the callback signature, the `CallToolResult` envelope) is confined to
 * this file, so the tools themselves (`tools/status.ts`, …) stay decoupled from
 * the SDK surface and depend only on the {@link CaucusSession}.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";

/**
 * A Caucus tool: a name, a model-facing description, an input schema (a Zod raw
 * shape — `{}` for a no-argument tool), and a handler that receives the bound
 * {@link CaucusSession} plus the parsed args and returns an MCP
 * {@link CallToolResult}. The handler reaches the backbone only through the
 * session, so identity stamping (ADR-C7) is never bypassed.
 */
export interface CaucusTool {
  /** The tool name the client invokes (e.g. `caucus_status`). */
  readonly name: string;
  /** Concise, model-facing description of what the tool does. */
  readonly description: string;
  /** Zod raw shape for the tool's input; `{}` for a no-argument tool. */
  readonly inputSchema: ZodRawShapeCompat;
  /** Execute the tool against the session, returning an MCP result. */
  handle(
    session: CaucusSession,
    args: Record<string, unknown>,
  ): Promise<CallToolResult>;
}

/**
 * Register every {@link CaucusTool} on an {@link McpServer}, binding each to the
 * given session. This is the one place that speaks the SDK's `registerTool`
 * dialect; everything else deals in {@link CaucusTool}.
 */
export function registerTools(
  server: McpServer,
  session: CaucusSession,
  tools: readonly CaucusTool[],
): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      (args: Record<string, unknown>): Promise<CallToolResult> =>
        tool.handle(session, args),
    );
  }
}
