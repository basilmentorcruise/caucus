/**
 * Server assembly (CAU-9).
 *
 * {@link createCaucusServer} wires the pieces together: it builds the
 * {@link CaucusSession} from config + backbone, instantiates the MCP
 * {@link McpServer}, and registers the tool set. It returns the server
 * *un-connected* — attaching a transport is the caller's job (`index.ts` uses
 * stdio; tests use an in-memory transport). That separation is what makes the
 * whole server testable in-process without spawning a subprocess.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Backbone } from "@caucus/backbone";
import type { ServerConfig } from "./config.js";
import { createSession } from "./session.js";
import { registerTools, type CaucusTool } from "./tools/registry.js";
import { statusTool } from "./tools/status.js";

/** Inputs to {@link createCaucusServer}. */
export interface CreateCaucusServerOptions {
  /** Resolved identity + channel. */
  readonly config: ServerConfig;
  /** The backbone the session writes to / reads from. */
  readonly backbone: Backbone;
  /**
   * The tools to register. Defaults to the built-in diagnostic set
   * (`[statusTool]`); real tools (CAU-10/11/12) are injected here.
   */
  readonly tools?: readonly CaucusTool[];
}

/**
 * Build a fully-configured but UN-connected {@link McpServer}: session bound,
 * tools registered, no transport attached. Call `server.connect(transport)` to
 * start serving.
 */
export function createCaucusServer({
  config,
  backbone,
  tools = [statusTool],
}: CreateCaucusServerOptions): McpServer {
  const session = createSession(config, backbone);
  const server = new McpServer({
    name: "caucus-mcp",
    version: "0.0.0",
  });
  registerTools(server, session, tools);
  return server;
}
