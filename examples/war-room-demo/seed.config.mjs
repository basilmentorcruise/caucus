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
 * Build the `CAUCUS_TOKENS` value the backbone must boot with so it accepts the
 * demo's bearers — `token:agent_id:owner` triples, comma-separated. Documented
 * in the README and used by the test to start the tokened server.
 */
export function tokensEnv() {
  return IDENTITIES.map((i) => `${i.token}:${i.agent_id}:${i.owner}`).join(",");
}
