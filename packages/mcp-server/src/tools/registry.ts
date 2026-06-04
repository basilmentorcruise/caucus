/**
 * Tool-registration mechanics + result-envelope alias (CAU-9).
 *
 * Caucus tools are described by the transport-agnostic {@link CaucusTool}
 * interface; {@link registerTools} is the single adapter that maps them onto the
 * MCP SDK's `registerTool`. The SDK-specific registration shape (the
 * `registerTool` config object and callback signature) is confined to this
 * file, and the result envelope is re-exported here as {@link ToolResult} so
 * tools import that one seam rather than reaching into the SDK's `types.js`
 * directly. (Tools still depend on the SDK's Zod-raw-shape type for their input
 * schema; this file is the seam for registration mechanics and the result
 * alias, not a full SDK firewall.)
 *
 * WARNING for tool authors (ADR-C12): when a `handle` throws, the SDK echoes the
 * thrown error's *message* into the channel-visible {@link ToolResult} as text
 * (with `isError: true`). Never build an error message out of a token, secret,
 * or other sensitive value — sanitize before throwing, or the secret lands in
 * the shared log.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";

/**
 * The MCP tool-result envelope, re-exported as the local seam Caucus tools
 * import. Aliased to the SDK's `CallToolResult` so tools (`tools/status.ts`, …)
 * depend on this module rather than the SDK's `types.js` directly.
 */
export type ToolResult = CallToolResult;

/**
 * A Caucus tool: a name, a model-facing description, an input schema (a Zod raw
 * shape — `{}` for a no-argument tool), and a handler that receives the bound
 * {@link CaucusSession} plus the parsed args and returns a {@link ToolResult}.
 * The handler reaches the backbone only through the session, so identity
 * stamping (ADR-C7) is never bypassed.
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
  ): Promise<ToolResult>;
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
      (args: Record<string, unknown>): Promise<ToolResult> =>
        tool.handle(session, args),
    );
  }
}
