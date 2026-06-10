/**
 * War-room demo — the single source of truth for the seed data (CAU-27).
 *
 * The README, the `seed.mjs` script, and the integration scenario
 * (`demo-seed.itest.ts`) all import THIS module, so the three demo identities,
 * the channel, and the deterministic posts are defined exactly once. Change a
 * value here and the demo, its docs, and its test move together.
 *
 * These are throwaway DEMO secrets, not real credentials: the tokens exist only
 * to prove the CAU-13 anchoring path end to end (the server resolves a bearer
 * to its `{ agent_id, owner }` and stamps THAT identity onto every write, so the
 * owner stored on a message cannot be forged). Never reuse them outside the demo.
 */

/**
 * The three demo principals. Each `token` is the bearer the matching client
 * presents; the server (booted with the corresponding `CAUCUS_TOKENS` entry)
 * resolves it to `{ agent_id, owner }` and anchors every write to it (ADR-C7).
 */
export const IDENTITIES = [
  { token: "tok-alice", agent_id: "sess-alice", owner: "alice" },
  { token: "tok-bob", agent_id: "sess-bob", owner: "bob" },
  { token: "tok-carol", agent_id: "sess-carol", owner: "carol" },
];

/** The war-room channel the demo investigates in. */
export const CHANNEL = "war-room-incident-42";

/** The channel's purpose — what this war room is investigating. */
export const PURPOSE = "incident-42: checkout p95 latency spike";

/**
 * The deterministic opening scene alice posts so the channel isn't empty when
 * the demo starts: a `note` steer that frames the incident, then one `finding`.
 * Deterministic bodies (no timestamps/ids) keep the demo reproducible and let
 * the test assert on exact text.
 */
export const OPENING_SCENE = [
  {
    type: "note",
    body: "incident: checkout p95 spiked at 14:02 — opening the war room. Claim a hypothesis before you dig.",
  },
  {
    type: "finding",
    body: "checkout p95 jumped 180ms→1.4s at 14:02, exactly when the cart-service deploy went out.",
  },
];

/**
 * The body carol posts TWICE (back to back) under `--loop` to trigger the
 * seatbelt's loop/duplicate guard (ADR-C8). The second identical post is
 * rejected with an actionable `DuplicatePostError` — that rejection IS the point
 * of the demo, so the script treats it as success (exit 0).
 */
export const LOOP_BODY =
  "still seeing elevated p95 — anyone else? still seeing elevated p95 — anyone else?";

/** Default backbone URL the seed talks to (localhost-only; see ADR-C9). */
export const DEFAULT_URL = "http://127.0.0.1:4317";

/**
 * The make-style `VAR=value` keys EVERY demo script honors (URL resolution).
 * Scripts pass the keys they actually apply to {@link parseArgs} — a key a
 * script accepts but never reads is the exact silent-swallow CAU-61 killed
 * (reintroduced for `CHANNEL` and re-killed in CAU-76).
 */
export const URL_ARG_KEYS = ["PORT", "CAUCUS_URL"];

/** The keys the watcher honors: URL resolution + channel selection (CAU-67). */
export const WATCH_ARG_KEYS = [...URL_ARG_KEYS, "CHANNEL"];

/**
 * Watch-all sentinel + flag (CAU-67). `--all` (CLI) or `CHANNEL=*` (make-style,
 * survives `make watch CHANNEL='*'`) makes the watcher multiplex every channel
 * instead of tailing one.
 */
export const WATCH_ALL_FLAG = "--all";
export const WATCH_ALL_CHANNEL = "*";

/**
 * Parse make-style `VAR=value` positional args (`pnpm demo:run PORT=4747` —
 * the owner's muscle memory from `make demo PORT=4747`, where make parses
 * `VAR=value` anywhere). Returns the overrides; rejects genuinely unknown
 * args LOUDLY (silently ignoring one once sent the demo at the wrong port
 * with an opaque `fetch failed`).
 *
 * `keys` scopes which `VAR=` overrides THIS script honors (CAU-76): a key the
 * script would parse but never apply (e.g. `CHANNEL=` to `seed.mjs`, whose
 * channel is fixed by the seed config) is rejected loudly like any unknown
 * arg, never silently swallowed.
 */
export function parseArgs(argv, allowed = [], keys = URL_ARG_KEYS) {
  const overrides = {};
  const unknown = [];
  for (const a of argv) {
    // `--` is the standard end-of-options separator (pnpm forwards it through
    // on `pnpm demo:seed -- --loop`) — never an unknown arg.
    if (a === "--" || allowed.includes(a)) continue;
    const eq = a.indexOf("=");
    const key = eq > 0 ? a.slice(0, eq) : undefined;
    if (key !== undefined && keys.includes(key)) {
      overrides[key] = a.slice(eq + 1);
    } else {
      unknown.push(a);
    }
  }
  if (unknown.length > 0) {
    console.error(
      `unknown/unsupported argument(s): ${unknown.join(" ")}\n` +
        `This script supports: ${allowed.join(" ") || "(no flags)"} and make-style ` +
        `${keys.map((k) => `${k}=…`).join(" / ")}, e.g.:\n` +
        `  pnpm demo:run PORT=4747\n` +
        `  make demo PORT=4747`,
    );
    process.exit(2);
  }
  return overrides;
}

/**
 * Resolve the backbone URL: make-style arg overrides win (mirroring make,
 * where command-line `VAR=value` beats the environment), then `CAUCUS_URL`
 * env, then `PORT` env (matching the backbone bin), then the default.
 */
export function resolveUrl(env = process.env, overrides = {}) {
  const url = overrides.CAUCUS_URL ?? env.CAUCUS_URL;
  if (url && url.trim() !== "") return url.trim();
  const port = overrides.PORT ?? env.PORT;
  if (port && port.trim() !== "") return `http://127.0.0.1:${port.trim()}`;
  return DEFAULT_URL;
}

/**
 * Resolve which channel to watch (CAU-67), mirroring `resolveUrl`'s precedence:
 * make-style `CHANNEL=` arg override wins, then `CAUCUS_CHANNEL` env, then the
 * demo channel (so the demo and its tests are unchanged when nothing is set).
 * A blank value (e.g. `make watch CHANNEL=`) counts as unset.
 */
export function resolveChannel(env = process.env, overrides = {}) {
  const ch = overrides.CHANNEL ?? env.CAUCUS_CHANNEL;
  if (ch && ch.trim() !== "") return ch.trim();
  return CHANNEL;
}

/**
 * Whether the watcher should multiplex ALL channels (CAU-67): the `--all` flag
 * on the command line, or the resolved channel being the `*` sentinel
 * (`make watch CHANNEL='*'`, since make can't pass a bare `--all`).
 */
export function isWatchAll(argv = [], env = process.env, overrides = {}) {
  if (argv.includes(WATCH_ALL_FLAG)) return true;
  return resolveChannel(env, overrides) === WATCH_ALL_CHANNEL;
}

/**
 * Build the `CAUCUS_TOKENS` value the backbone must boot with so it accepts the
 * demo's bearers — `token:agent_id:owner` triples, comma-separated. Documented
 * in the README and used by the test to start the tokened server.
 */
export function tokensEnv() {
  return IDENTITIES.map((i) => `${i.token}:${i.agent_id}:${i.owner}`).join(",");
}
