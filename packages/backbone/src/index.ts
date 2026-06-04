/**
 * @caucus/backbone — the channel service behind one implementation-agnostic
 * interface: append-only log, first-write-wins claim ledger, and cursors.
 *
 * CAU-4 ships the contract (`Backbone` + envelope types), the error taxonomy,
 * and the `InMemoryBackbone` reference implementation. Durability (SQLite), the
 * MCP transport, seatbelts, identity anchoring, and lease enforcement arrive in
 * later tickets (CAU-5/6/7/18). Normative semantics: `docs/BACKBONE_CONTRACT.md`.
 */
export type {
  AppendedMessage,
  AppendResult,
  Backbone,
  ChannelDescriptor,
  ClaimResult,
  CreateChannelOptions,
  Cursor,
  ReadResult,
  Verbosity,
} from "./contract.js";
export {
  BackboneError,
  ChannelExistsError,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  UnknownChannelError,
} from "./errors.js";
export { InMemoryBackbone, MAX_BODY_CHARS } from "./in-memory.js";
