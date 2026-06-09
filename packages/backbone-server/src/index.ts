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
 * Localhost-only. WRITES are token-gated and the resolved identity is anchored
 * onto every message (CAU-13, ADR-C7); READS stay open within the trust
 * boundary (ADR-C9). Fail-closed: with no `CAUCUS_TOKENS` configured, all writes
 * return `401`. No disk persistence: durability is deferred. The `append`/`read`
 * routes are thin pass-throughs; CAU-6 refines `readSince` limit semantics +
 * adds seatbelts and CAU-7 adds the server-side `claim` route handler.
 */
export type {
  AuthContext,
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
  parseTokenMap,
  resolveToken,
  tokenDigest,
  TokenMapParseError,
  type TokenIdentity,
  type TokenMap,
} from "./tokens.js";
export {
  mapError,
  backboneErrorFromWire,
  UnauthorizedError,
  type MappedError,
  type WireErrorBody,
} from "./wire-errors.js";
