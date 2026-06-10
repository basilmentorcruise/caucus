/**
 * Schema version. v1 is the only supported version. v0 was ratified and frozen
 * in M0 (CAU-3); v1 (CAU-99) adds the first-class `steer` (human-directive)
 * message type. The version gate is an EXACT match (a hard cutover, ADR-C13):
 * decoding a v0 message now throws `UnsupportedVersionError`. Breaking changes
 * require bumping this and widening the version gate.
 */
export const SCHEMA_VERSION = 1 as const;
