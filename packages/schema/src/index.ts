/**
 * @caucus/schema — versioned typed-message schema + codec (shared, zero
 * runtime dependencies).
 *
 * Schema v0 is ratified and frozen in M0 (CAU-3). This package is a pure leaf
 * library: it defines the message types, a strict codec (`encode`/`decode`),
 * and ULID/target helpers. It performs NO identity auth, NO `ts` stamping, and
 * NO lease enforcement — those live in the backbone/MCP/hook (ADR-C7, CAU-18).
 */
export { SCHEMA_VERSION } from "./version.js";
export {
  MESSAGE_TYPES,
  STATUS_VALUES,
  INJECTED_DELTA_CAP_CHARS,
  MAX_ERROR_FRAGMENT_CHARS,
  MAX_RECIPIENTS,
  MAX_FIELD_CHARS,
} from "./constants.js";
export type {
  MessageType,
  StatusValue,
  BaseMessageInput,
  ClaimMessageInput,
  MessageInput,
  CaucusMessage,
} from "./types.js";
export {
  SchemaError,
  UnsupportedVersionError,
  MalformedMessageError,
} from "./errors.js";
export {
  stripControlChars,
  stripControlCharsKeepWhitespace,
  sanitizeErrorFragment,
  containsControlChars,
  containsControlCharsExceptWhitespace,
} from "./sanitize.js";
export { sanitizeMessageFields } from "./sanitize-message.js";
export { isUlid, newMsgId } from "./ulid.js";
export { normalizeTarget } from "./target.js";
export { validate, validateIdentityField } from "./validate.js";
export { encode, decode } from "./codec.js";
