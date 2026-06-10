/**
 * @caucus/mcp-server library surface.
 *
 * The package's `index.ts` is the executable bin (it spawns over stdio on
 * import), so it is NOT importable as a library. This module is the testable
 * surface other packages (the integration harness) consume: the session
 * factory, its types, the tool set, and the server's own error taxonomy. It runs
 * no side effects on import.
 */
export {
  createSession,
  type CaucusSession,
  type BackboneReader,
  type SessionCreateChannelOptions,
} from "./session.js";
export { type ServerConfig, type SessionIdentity } from "./config.js";
export { NotJoinedError } from "./errors.js";
export {
  type CaucusTool,
  type ToolResult,
} from "./tools/registry.js";
export { postTool, postFindingTool, steerTool } from "./tools/post.js";
export { claimTool } from "./tools/claim.js";
export { statusTool } from "./tools/status.js";
export { subscribeTool } from "./tools/subscribe.js";
export { readChannelTool } from "./tools/read-channel.js";
export {
  listChannelsTool,
  describeChannelTool,
  createChannelTool,
  joinChannelTool,
} from "./tools/channels.js";
