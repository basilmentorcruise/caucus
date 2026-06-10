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
  ChannelFullError,
  ChannelLimitError,
  DuplicatePostError,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  RateLimitedError,
  type RateLimitScope,
  UnknownChannelError,
} from "./errors.js";
export {
  DEFAULT_MAX_CHANNELS,
  DEFAULT_MAX_MESSAGES_PER_CHANNEL,
  DEFAULT_MAX_READ_LIMIT,
  InMemoryBackbone,
  type InMemoryBackboneOptions,
  MAX_BODY_CHARS,
  MAX_FIELD_CHARS,
} from "./in-memory.js";
export {
  DEFAULT_DUP_WINDOW,
  DEFAULT_GLOBAL_RATE_MULTIPLIER,
  DEFAULT_MAX_CHANNEL_CREATES_PER_MINUTE,
  DEFAULT_MAX_POSTS_PER_MINUTE,
  DEFAULT_MAX_TRACKED_AGENTS,
  SEATBELT_WINDOW_MS,
  type SeatbeltOptions,
} from "./seatbelt.js";
