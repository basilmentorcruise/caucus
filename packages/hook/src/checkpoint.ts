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

/** On-disk checkpoint format. `v` lets the format evolve without misreads. */
interface CheckpointFile {
  readonly cursor: number;
  readonly channel: string;
  readonly v: 0;
}

/** Current checkpoint format version. */
const CHECKPOINT_VERSION = 0 as const;

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
 * Read the checkpoint cursor at `path`, requiring it to match `channel`.
 *
 * Returns a non-negative integer cursor, or `undefined` when there is no usable
 * checkpoint: file missing, unreadable, non-JSON, wrong shape, a `channel` that
 * doesn't match, a non-integer or negative `cursor`. The caller treats
 * `undefined` as "first run for this session+channel".
 */
export async function readCheckpoint(
  path: string,
  channel: string,
): Promise<number | undefined> {
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

  const cursor = obj.cursor;
  if (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0) {
    return undefined;
  }
  return cursor;
}

/**
 * Atomically write `cursor` for `channel` to `path`. Creates the parent
 * directory if needed, writes a temp file, then renames it over the target so a
 * reader never observes a partially-written file.
 */
export async function writeCheckpoint(
  path: string,
  cursor: number,
  channel: string,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const payload: CheckpointFile = { cursor, channel, v: CHECKPOINT_VERSION };
  // A per-process temp name so concurrent writers (e.g. two sessions) don't
  // collide on the temp file before the atomic rename.
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(payload), "utf8");
  await rename(tmp, path);
}
