/**
 * @caucus/backbone-server — the standalone HTTP backbone service + its HTTP
 * client (CAU-5).
 *
 * One shared server (ADR-C9), HTTP+JSON over localhost, stateless (CAU-2). The
 * server is a thin transport over an in-process {@link Backbone} (the backbone
 * remains the single validation authority); the {@link HttpBackbone} client
 * implements the SAME `Backbone` contract over `fetch`, so the CAU-25 harness
 * runs every scenario over the wire.
 *
 * v0 is UNAUTHENTICATED and localhost-only — identity anchoring is CAU-9/13. No
 * disk persistence: durability is deferred. The `append`/`read` routes are thin
 * pass-throughs; CAU-6 refines `readSince` limit semantics + adds seatbelts and
 * CAU-7 adds the server-side `claim` route handler.
 */
export type {
  DispatchResult,
  RunningServer,
  ServerOptions,
} from "./server.js";
export {
  createServer,
  dispatch,
  startServer,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
} from "./server.js";
export { HttpBackbone, type HttpBackboneOptions } from "./http-client.js";
export { parseEnvConfig, type EnvConfig } from "./config.js";
export {
  mapError,
  backboneErrorFromWire,
  type MappedError,
  type WireErrorBody,
} from "./wire-errors.js";
