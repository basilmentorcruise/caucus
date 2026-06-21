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
 *
 * Control-byte hygiene (CAU-88): the backbone/schema error constructors already
 * strip C0/DEL/C1 from their `.message` / `.issues[]` at CONSTRUCTION — covering
 * BOTH MCP wirings (the in-process `InMemoryBackbone` fallback, whose errors
 * never traverse the wire, and the shared `HttpBackbone` mode, whose errors are
 * reconstructed clean by `backboneErrorFromWire`). So the error message the SDK
 * surfaces here is control-byte-free with no extra strip in this layer. Tool
 * authors must NOT undo that by interpolating raw caller content into a
 * `handle()` error message after the fact — sanitize any fragment first.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CaucusSession } from "../session.js";
import { parseToolArgs } from "./friendly-validation.js";

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
 *
 * Two responsibilities:
 * 1. `registerTool` each tool so its description + input schema are ADVERTISED in
 *    `tools/list` (the model's source of argument hints).
 * 2. Install ONE custom `tools/call` handler (CAU-123) that does our own
 *    friendly arg-validation (re-using each tool's OWN schema via
 *    {@link parseToolArgs}) before dispatching. This REPLACES the SDK's default
 *    `tools/call` handler — and with it the SDK's raw `-32602` "Input validation
 *    error: …[JSON issue dump]…" — with a clear, leak-free message naming the
 *    offending argument. Advertisement (`tools/list`) still flows through the
 *    SDK's registry untouched; only the call-time validation message changes.
 */
export function registerTools(
  server: McpServer,
  session: CaucusSession,
  tools: readonly CaucusTool[],
): void {
  const byName = new Map<string, CaucusTool>();
  for (const tool of tools) {
    byName.set(tool.name, tool);
    // Advertise via the SDK registry (description + inputSchema in tools/list).
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      // This callback is the SDK's normal dispatch path; it is SUPERSEDED below
      // by our custom tools/call handler, but registering it keeps the tool
      // advertised and is the documented `registerTool` shape.
      (args: Record<string, unknown>): Promise<ToolResult> =>
        tool.handle(session, args),
    );
  }

  // Supersede the SDK's tools/call handler with one that validates with friendly
  // messages, then dispatches. registerTool (above) installed the SDK default;
  // setRequestHandler on the underlying Server overrides it (last writer wins),
  // so tools/list keeps the SDK's advertisement while tools/call gets ours.
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const tool = byName.get(name);
    if (tool === undefined) {
      // Unknown tool: a clean, leak-free error result (the name is the client's
      // own requested tool name, not channel content).
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }

    const rawArgs = (request.params.arguments ?? {}) as Record<string, unknown>;
    const parsed = parseToolArgs(tool.inputSchema, rawArgs);
    if (!parsed.ok) {
      // Friendly, value-free validation message (CAU-123) in place of the SDK's
      // raw -32602 dump.
      return {
        content: [{ type: "text", text: parsed.message }],
        isError: true,
      };
    }

    try {
      return await tool.handle(session, parsed.value);
    } catch (err) {
      // Mirror the SDK's handler-error behavior: surface the (already control-
      // stripped, value-free per ADR-C12) message as isError text. See the
      // module-level WARNING — tool authors must not interpolate secrets.
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text", text: message }],
        isError: true,
      };
    }
  });
}
