/**
 * Integration scenario — `caucus token` (CAU-129) drives the issuer admin
 * surface end-to-end over a REAL backbone process, through the REAL `caucus`
 * bin (`dist/cli/bin.js`) spawned as its own OS process.
 *
 * This is the empirical proof of CAU-129's ACs that an in-process unit test
 * cannot give: the CLI shells out, reads its admin credential from the spawned
 * process's ENVIRONMENT (never a flag), hits the live loopback control routes,
 * and the minted token is then used as a real bearer against the write path —
 * and after a revoke through the CLI the SAME bearer is rejected (401), with no
 * server restart.
 *
 * Covered, end-to-end:
 *  - mint → the printed token authorizes an anchored append → revoke (via the
 *    CLI) → the same bearer 401s. The token is on STDOUT once with a one-time
 *    warning, and the admin credential never appears in stdout or stderr.
 *  - admin-token UNSET → exit non-zero with a value-free error (no token bytes),
 *    and the CLI never dials.
 *  - a `--admin-token` flag is rejected (the credential is env-only, ADR-C12).
 *
 * The bins are built once in the integration `globalSetup`.
 */
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { newMsgId } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServerProcess } from "../harness.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const CAUCUS_BIN = join(REPO_ROOT, "packages", "mcp-server", "dist", "cli", "bin.js");

const SEED_TOKENS = "seed-alice:alice-agent:alice";
const ADMIN_TOKEN = "integration-admin-cli-secret";
const CH = "incident-admin-cli";

/** process.env with undefined stripped, plus overrides — a plain child env. */
function childEnv(overrides: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) base[k] = v;
  }
  return { ...base, ...overrides };
}

/** Run `node dist/cli/bin.js token <args...>` with the given env; capture I/O. */
function runCaucusToken(
  args: string[],
  env: Record<string, string>,
): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("node", [CAUCUS_BIN, "token", ...args], {
    cwd: REPO_ROOT,
    env: childEnv(env),
    encoding: "utf8",
  });
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** POST a JSON body with an optional bearer; return [status, parsedBody]. */
async function postJson(
  url: string,
  bearer: string | undefined,
  body: unknown,
): Promise<[number, Record<string, unknown>]> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearer !== undefined) headers.authorization = `Bearer ${bearer}`;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  return [res.status, text === "" ? {} : (JSON.parse(text) as Record<string, unknown>)];
}

describe("caucus token (CAU-129) — over a real backbone process", () => {
  let url: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const started = await startServerProcess({
      CAUCUS_TOKENS: SEED_TOKENS,
      CAUCUS_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    url = started.url;
    stop = started.stop;
    const [status] = await postJson(`${url}/channels`, "seed-alice", {
      channel: CH,
      purpose: "admin-cli integration",
      created_by: "anything",
    });
    expect(status).toBe(201);
  });

  afterAll(async () => {
    await stop();
  });

  it("mint prints one usable token + one-time warning; the admin token never leaks", () => {
    const out = runCaucusToken(["mint", "--owner", "alice", "--agent", "sess-alice"], {
      CAUCUS_URL: url,
      CAUCUS_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    expect(out.status).toBe(0);

    // The token is on STDOUT — exactly one non-empty stdout line (the bare token).
    const stdoutLines = out.stdout.split("\n").filter((l) => l.trim() !== "");
    expect(stdoutLines).toHaveLength(1);
    const token = stdoutLines[0]!.trim();
    expect(token.length).toBeGreaterThan(0);

    // The one-time-copy warning is on stderr.
    expect(out.stderr).toMatch(/copy it now/i);
    expect(out.stderr).toMatch(/not re-readable/i);

    // ADR-C12: the admin credential appears in NEITHER stream.
    expect(out.stdout).not.toContain(ADMIN_TOKEN);
    expect(out.stderr).not.toContain(ADMIN_TOKEN);
  });

  it("the minted token authorizes an anchored append; after a CLI revoke it is rejected", async () => {
    // Mint via the CLI and grab the printed token from stdout.
    const mint = runCaucusToken(["mint", "--owner", "rena", "--agent", "sess-rena"], {
      CAUCUS_URL: url,
      CAUCUS_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    expect(mint.status).toBe(0);
    const token = mint.stdout.split("\n").filter((l) => l.trim() !== "")[0]!.trim();

    // The minted token works as a real bearer; identity is server-anchored.
    const [appendStatus] = await postJson(`${url}/channels/${CH}/append`, token, {
      type: "finding",
      agent_id: "forged",
      owner: "forged",
      msg_id: newMsgId(),
      body: "minted-by-cli",
    });
    expect(appendStatus).toBe(201);
    const [, log] = await postJson(`${url}/channels/${CH}/read`, undefined, { cursor: 0 });
    const messages = log.messages as { owner: string; agent_id: string; body: string }[];
    const posted = messages.find((m) => m.body === "minted-by-cli");
    expect(posted?.owner).toBe("rena");
    expect(posted?.agent_id).toBe("sess-rena");

    // Revoke via the CLI by the agent id (the by-agent sweep).
    const revoke = runCaucusToken(["revoke", "agent:sess-rena"], {
      CAUCUS_URL: url,
      CAUCUS_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    expect(revoke.status).toBe(0);
    expect(revoke.stderr).toMatch(/revoked/i);

    // The SAME bearer is now rejected — no server restart.
    const [afterStatus] = await postJson(`${url}/channels/${CH}/append`, token, {
      type: "finding",
      agent_id: "sess-rena",
      owner: "rena",
      msg_id: newMsgId(),
      body: "after-cli-revoke",
    });
    expect(afterStatus).toBe(401);
  });

  it("admin token UNSET → exits non-zero with a value-free error, never dials", () => {
    // No CAUCUS_ADMIN_TOKEN in the child env — must fail before any network call.
    const env = childEnv({ CAUCUS_URL: url });
    delete env.CAUCUS_ADMIN_TOKEN;
    const r = spawnSync("node", [CAUCUS_BIN, "token", "mint", "--owner", "o", "--agent", "a"], {
      cwd: REPO_ROOT,
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CAUCUS_ADMIN_TOKEN");
    expect(r.stdout).toBe(""); // nothing minted, nothing printed
  });

  it("a --admin-token flag is rejected (env-only credential, ADR-C12)", () => {
    const out = runCaucusToken(
      ["mint", "--admin-token", "should-not-work", "--owner", "o", "--agent", "a"],
      { CAUCUS_URL: url, CAUCUS_ADMIN_TOKEN: ADMIN_TOKEN },
    );
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("--admin-token is not accepted");
    // The flag value the user passed is never echoed.
    expect(out.stdout).not.toContain("should-not-work");
    expect(out.stderr).not.toContain("should-not-work");
  });
});
