/**
 * Per-session, per-channel cursor checkpoint persistence (CAU-14).
 *
 * The hook injects only messages newer than the last turn (ADR-C3/C4). It
 * remembers "where it got to" in a tiny JSON file keyed by `(sessionId,
 * channel)`, so a session resumed across turns picks up exactly where it left
 * off, and two channels in the same session never clobber each other.
 *
 * Path: `~/.caucus/checkpoints/<sessionId>__<channel>.json`. Both key parts are
 * sanitized so a hostile/odd `sessionId` or `channel` can't escape the
 * directory (no `/`, `\\`, `..`, etc. survive into the filename).
 *
 * Reads are TOTAL and forgiving: any problem (missing file, corrupt JSON, a
 * channel that doesn't match the filename's channel, a non-integer / negative
 * cursor) returns `undefined` — "no usable checkpoint" — which the caller treats
 * as a first run (mint at head, inject nothing). Writes are atomic (temp file +
 * rename) so a crash mid-write never leaves a torn checkpoint.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * A record of the last NON-EMPTY delta this session+channel injected (CAU-93):
 * the checkpoint `cursor` after that injection, the EXACT `block` string the hook
 * wrapped into `additionalContext` (byte-equal to what the agent saw — A3), and
 * the wall-clock `ts` it was written. Persisted so "did the hook deliver, and
 * what?" is answerable from the hook's own state via {@link readLastInjection},
 * without an MCP round-trip (the MCP server has no Claude Code session_id, so it
 * cannot key "this session's" injection — a `caucus_last_injection` MCP tool is a
 * possible follow-up, out of scope here).
 */
export interface LastInjection {
  readonly cursor: number;
  readonly block: string;
  readonly ts: string;
}

/**
 * On-disk checkpoint format. `v` lets the format evolve without misreads.
 *
 * v0 (CAU-14) had only `{ cursor, channel, v: 0 }`. v1 (CAU-93) adds an optional
 * {@link LastInjection}. The read path stays forgiving and BACKWARD-COMPATIBLE: a
 * v0 file (no `lastInjection`) still yields a valid cursor; `lastInjection` is
 * read defensively and any malformed/absent value simply reads back as
 * `undefined` from {@link readLastInjection} without affecting the cursor.
 */
interface CheckpointFile {
  readonly cursor: number;
  readonly channel: string;
  readonly v: 0 | 1;
  readonly lastInjection?: LastInjection;
}

/** Current checkpoint format version (v0 → v1 added `lastInjection`, CAU-93). */
const CHECKPOINT_VERSION = 1 as const;

/**
 * Reduce a key part to a filename-safe token: collapse any run of characters
 * that are not `[A-Za-z0-9_-]` (notably `/`, `\`, and `.`) to a single `-`.
 * Dropping `.` as well neutralizes `.`/`..` segments outright, so the result is
 * always a single, traversal-safe path segment. Legitimate keys (channel slugs
 * `[a-z0-9-]`, UUID-ish session ids) contain none of the collapsed characters.
 */
function sanitizeKeyPart(part: string): string {
  return part.replace(/[^A-Za-z0-9_-]+/g, "-");
}

/** The directory checkpoints live in: `~/.caucus/checkpoints`. */
export function checkpointDir(home: string = homedir()): string {
  return join(home, ".caucus", "checkpoints");
}

/**
 * Absolute path to the checkpoint file for `(sessionId, channel)`. Both parts
 * are sanitized (see {@link sanitizeKeyPart}); the channel is also stored
 * *inside* the file so a sanitization collision between two channels is caught
 * on read (channel mismatch ⇒ `undefined`).
 */
export function checkpointPath(
  sessionId: string,
  channel: string,
  home: string = homedir(),
): string {
  const file = `${sanitizeKeyPart(sessionId)}__${sanitizeKeyPart(channel)}.json`;
  return join(checkpointDir(home), file);
}

/**
 * Read and channel-validate the checkpoint file at `path`. Shared by
 * {@link readCheckpoint} and {@link readLastInjection}: any problem (missing /
 * unreadable file, non-JSON, wrong shape, a `channel` that doesn't match) yields
 * `undefined` so both accessors stay TOTAL and forgiving. This deliberately does
 * NOT validate `cursor` or `lastInjection` — each accessor validates the field
 * it returns, so a v0 file (no `lastInjection`) still yields a cursor and a file
 * with a garbled `lastInjection` still yields its cursor.
 */
async function readCheckpointFile(
  path: string,
  channel: string,
): Promise<Partial<CheckpointFile> | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    // Missing / unreadable file: no checkpoint yet.
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON: treat as no checkpoint rather than crash the turn.
    return undefined;
  }

  if (parsed === null || typeof parsed !== "object") return undefined;
  const obj = parsed as Partial<CheckpointFile>;

  // The stored channel must match the channel we're reading for; otherwise a
  // filename collision (two channels that sanitize the same) would silently
  // cross the streams. Mismatch ⇒ no usable checkpoint.
  if (obj.channel !== channel) return undefined;
  return obj;
}

/**
 * Read the checkpoint cursor at `path`, requiring it to match `channel`.
 *
 * Returns a non-negative integer cursor, or `undefined` when there is no usable
 * checkpoint: file missing, unreadable, non-JSON, wrong shape, a `channel` that
 * doesn't match, a non-integer or negative `cursor`. The caller treats
 * `undefined` as "first run for this session+channel". v0 and v1 files both read
 * back the same way (the v1 `lastInjection` field never affects the cursor).
 */
export async function readCheckpoint(
  path: string,
  channel: string,
): Promise<number | undefined> {
  const obj = await readCheckpointFile(path, channel);
  if (obj === undefined) return undefined;

  const cursor = obj.cursor;
  if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
    return undefined;
  }
  return cursor;
}

/**
 * Read the last NON-EMPTY injection recorded for `(path, channel)` (CAU-93), or
 * `undefined` when there is none: a v0 file (no `lastInjection`), a file whose
 * `lastInjection` is missing/malformed (non-object, non-integer/negative
 * `cursor`, non-string `block`/`ts`), or any unreadable/corrupt file. TOTAL and
 * forgiving like {@link readCheckpoint}; a present, well-formed record carries
 * the EXACT `block` byte-string the hook injected (A3), so an audit can compare
 * it against what the agent quoted.
 */
export async function readLastInjection(
  path: string,
  channel: string,
): Promise<LastInjection | undefined> {
  const obj = await readCheckpointFile(path, channel);
  if (obj === undefined) return undefined;

  const li = obj.lastInjection;
  if (li === null || typeof li !== "object") return undefined;
  const { cursor, block, ts } = li as Partial<LastInjection>;
  if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
    return undefined;
  }
  if (typeof block !== "string" || typeof ts !== "string") return undefined;
  return { cursor, block, ts };
}

/**
 * Atomically write `cursor` for `channel` to `path`, optionally recording the
 * last injection (CAU-93). Creates the parent directory if needed, writes a temp
 * file, then renames it over the target so a reader never observes a
 * partially-written file. When `lastInjection` is omitted, only the cursor is
 * persisted (mint / self-heal / empty delta) — an existing record is NOT carried
 * forward, matching the "what did we inject THIS turn" semantics.
 */
export async function writeCheckpoint(
  path: string,
  cursor: number,
  channel: string,
  lastInjection?: LastInjection,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const payload: CheckpointFile = {
    cursor,
    channel,
    v: CHECKPOINT_VERSION,
    ...(lastInjection !== undefined ? { lastInjection } : {}),
  };
  // A per-process temp name so concurrent writers (e.g. two sessions) don't
  // collide on the temp file before the atomic rename.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, path);
}
