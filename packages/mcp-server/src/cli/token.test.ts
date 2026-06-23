/**
 * Unit tests for `caucus token` (CAU-129): arg-parsing, every error path, and
 * the secret-hygiene invariants — the admin token is read from env only, never
 * echoed, and a `--admin-token` flag is rejected; the minted token is printed
 * once to stdout and never to a CLI-written file (the CLI writes none).
 *
 * The network is injected via a `FetchLike` stub so the route + payload + the
 * Authorization header are asserted without a real socket; the end-to-end
 * mint→use→revoke proof lives in the integration scenario.
 */
import { describe, expect, it } from "vitest";

import {
  ADMIN_TOKEN_ENV,
  URL_ENV,
  USAGE,
  parseArgs,
  runToken,
  type FetchLike,
  type TokenDeps,
} from "./token.js";
import { DEFAULT_URL } from "./init.js";

const ADMIN = "ADMIN-SECRET-xyz";

interface Captured {
  out: string[];
  err: string[];
  calls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }>;
}

/** Build a `runToken` deps harness with a scripted fetch response. */
function makeDeps(
  overrides: {
    env?: Record<string, string | undefined>;
    response?: { status: number; body: unknown };
    fetchImpl?: FetchLike;
  } = {},
): TokenDeps & Captured {
  const out: string[] = [];
  const err: string[] = [];
  const calls: Captured["calls"] = [];
  const response = overrides.response ?? { status: 201, body: {} };
  const fetchImpl: FetchLike =
    overrides.fetchImpl ??
    (async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      return {
        status: response.status,
        text: async () =>
          typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body),
      };
    });
  return {
    env: overrides.env ?? { [ADMIN_TOKEN_ENV]: ADMIN },
    log: (l) => out.push(l),
    errlog: (l) => err.push(l),
    fetch: fetchImpl,
    out,
    err,
    calls,
  };
}

/** Assert no string captured by the CLI contains the admin token bytes. */
function assertNoAdminLeak(deps: Captured): void {
  for (const line of [...deps.out, ...deps.err]) {
    expect(line).not.toContain(ADMIN);
  }
}

describe("parseArgs", () => {
  it("no subcommand → help", () => {
    expect(parseArgs([])).toEqual({ ok: true, command: { kind: "help" } });
  });

  it("--help / -h → help", () => {
    expect(parseArgs(["--help"])).toEqual({ ok: true, command: { kind: "help" } });
    expect(parseArgs(["-h"])).toEqual({ ok: true, command: { kind: "help" } });
  });

  it("unknown subcommand is rejected", () => {
    const r = parseArgs(["frobnicate"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown command");
  });

  it("mint requires --owner and --agent", () => {
    expect(parseArgs(["mint", "--owner", "alice", "--agent", "sess-alice"])).toEqual({
      ok: true,
      command: { kind: "mint", owner: "alice", agent: "sess-alice" },
    });
    expect(parseArgs(["mint", "--owner", "alice"]).ok).toBe(false);
    expect(parseArgs(["mint", "--agent", "a"]).ok).toBe(false);
    expect(parseArgs(["mint"]).ok).toBe(false);
  });

  it("mint rejects a positional argument", () => {
    const r = parseArgs(["mint", "extra", "--owner", "o", "--agent", "a"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no positional");
  });

  it("revoke requires exactly one digest", () => {
    expect(parseArgs(["revoke", "deadbeef"])).toEqual({
      ok: true,
      command: { kind: "revoke", digest: "deadbeef" },
    });
    expect(parseArgs(["revoke"]).ok).toBe(false);
    expect(parseArgs(["revoke", "a", "b"]).ok).toBe(false);
  });

  it("revoke rejects --owner/--agent", () => {
    const r = parseArgs(["revoke", "deadbeef", "--owner", "o"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("no --owner");
  });

  it("rotate requires digest + --owner + --agent", () => {
    expect(parseArgs(["rotate", "deadbeef", "--owner", "alice", "--agent", "a"])).toEqual({
      ok: true,
      command: { kind: "rotate", digest: "deadbeef", owner: "alice", agent: "a" },
    });
    expect(parseArgs(["rotate", "deadbeef"]).ok).toBe(false);
    expect(parseArgs(["rotate", "--owner", "o", "--agent", "a"]).ok).toBe(false);
  });

  it("a missing flag value is rejected", () => {
    expect(parseArgs(["mint", "--owner"]).ok).toBe(false);
    expect(parseArgs(["mint", "--owner", "--agent", "a"]).ok).toBe(false);
  });

  it("an unknown option is rejected", () => {
    const r = parseArgs(["mint", "--owner", "o", "--agent", "a", "--frob"]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("unknown option");
  });

  it("rejects a --admin-token flag (env-only credential, ADR-C12)", () => {
    for (const argv of [
      ["mint", "--admin-token", "X", "--owner", "o", "--agent", "a"],
      ["mint", "--admin-token=X", "--owner", "o", "--agent", "a"],
      ["revoke", "deadbeef", "--admin-token", "X"],
    ]) {
      const r = parseArgs(argv);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain("--admin-token is not accepted");
        expect(r.error).toContain(ADMIN_TOKEN_ENV);
      }
    }
  });
});

describe("runToken — help", () => {
  it("prints usage and exits 0 without touching the network", async () => {
    const deps = makeDeps();
    const code = await runToken(["--help"], deps);
    expect(code).toBe(0);
    expect(deps.out.join("\n")).toBe(USAGE);
    expect(deps.calls).toHaveLength(0);
  });
});

describe("runToken — admin token from env only", () => {
  it("exits non-zero with a value-free error when CAUCUS_ADMIN_TOKEN is unset", async () => {
    const deps = makeDeps({ env: {} });
    const code = await runToken(["mint", "--owner", "alice", "--agent", "a"], deps);
    expect(code).toBe(1);
    expect(deps.calls).toHaveLength(0); // never dialed
    const msg = deps.err.join("\n");
    expect(msg).toContain(ADMIN_TOKEN_ENV);
    expect(msg).toContain("not set");
  });

  it("treats an all-whitespace admin token as unset", async () => {
    const deps = makeDeps({ env: { [ADMIN_TOKEN_ENV]: "   " } });
    const code = await runToken(["revoke", "deadbeef"], deps);
    expect(code).toBe(1);
    expect(deps.calls).toHaveLength(0);
  });

  it("a parse error never dials and never echoes a passed admin-token flag value", async () => {
    const deps = makeDeps();
    const code = await runToken(
      ["mint", "--admin-token", "LEAK-ME", "--owner", "o", "--agent", "a"],
      deps,
    );
    expect(code).toBe(1);
    expect(deps.calls).toHaveLength(0);
    expect(deps.err.join("\n")).not.toContain("LEAK-ME");
  });
});

describe("runToken — mint", () => {
  it("POSTs the right route/payload with the env admin token in the Authorization header", async () => {
    const deps = makeDeps({
      env: { [ADMIN_TOKEN_ENV]: ADMIN, [URL_ENV]: "http://127.0.0.1:9999" },
      response: { status: 201, body: { token: "tok_NEWSECRET", agent_id: "a", owner: "alice" } },
    });
    const code = await runToken(["mint", "--owner", "alice", "--agent", "a"], deps);
    expect(code).toBe(0);
    expect(deps.calls).toHaveLength(1);
    const call = deps.calls[0]!;
    expect(call.url).toBe("http://127.0.0.1:9999/admin/tokens");
    expect(call.method).toBe("POST");
    expect(call.headers.authorization).toBe(`Bearer ${ADMIN}`);
    expect(JSON.parse(call.body)).toEqual({ agent_id: "a", owner: "alice" });
  });

  it("prints the minted token ONCE to stdout with a one-time-copy warning", async () => {
    const deps = makeDeps({
      response: { status: 201, body: { token: "tok_NEWSECRET", agent_id: "a", owner: "alice" } },
    });
    const code = await runToken(["mint", "--owner", "alice", "--agent", "a"], deps);
    expect(code).toBe(0);
    // The token is on stdout, exactly once, on its own line.
    const tokenLines = deps.out.filter((l) => l.includes("tok_NEWSECRET"));
    expect(tokenLines).toEqual(["tok_NEWSECRET"]);
    // The warning is on stderr and names the one-time nature.
    const warn = deps.err.join("\n");
    expect(warn).toMatch(/copy it now/i);
    expect(warn).toMatch(/not re-readable/i);
    // The admin credential never appears anywhere.
    assertNoAdminLeak(deps);
  });

  it("defaults the backbone URL when CAUCUS_URL is unset", async () => {
    const deps = makeDeps({
      env: { [ADMIN_TOKEN_ENV]: ADMIN },
      response: { status: 201, body: { token: "tok_X", agent_id: "a", owner: "o" } },
    });
    await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(deps.calls[0]!.url).toBe(`${DEFAULT_URL}/admin/tokens`);
  });

  it("strips a trailing slash on CAUCUS_URL so the route never doubles up", async () => {
    const deps = makeDeps({
      env: { [ADMIN_TOKEN_ENV]: ADMIN, [URL_ENV]: "http://127.0.0.1:4747/" },
      response: { status: 201, body: { token: "tok_X", agent_id: "a", owner: "o" } },
    });
    await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(deps.calls[0]!.url).toBe("http://127.0.0.1:4747/admin/tokens");
  });

  it("a 201 with no token is a clean failure (exit 1, no crash)", async () => {
    const deps = makeDeps({ response: { status: 201, body: { agent_id: "a" } } });
    const code = await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(code).toBe(1);
    expect(deps.err.join("\n")).toContain("no token");
  });

  it("a malformed (non-JSON) 201 body is a clean failure, not a crash", async () => {
    const deps = makeDeps({ response: { status: 201, body: "not json{{" } });
    const code = await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(code).toBe(1);
    expect(deps.err.join("\n")).toContain("no token");
  });
});

describe("runToken — revoke", () => {
  it("revoke <digest> POSTs { digest } and reports success on { revoked: true }", async () => {
    const deps = makeDeps({ response: { status: 200, body: { revoked: true } } });
    const code = await runToken(["revoke", "deadbeefcafe"], deps);
    expect(code).toBe(0);
    expect(deps.calls[0]!.url).toContain("/admin/tokens/revoke");
    expect(JSON.parse(deps.calls[0]!.body)).toEqual({ digest: "deadbeefcafe" });
    expect(deps.err.join("\n")).toMatch(/revoked/i);
  });

  it("revoke agent:<id> POSTs { agent_id } (the by-agent sweep)", async () => {
    const deps = makeDeps({ response: { status: 200, body: { revoked: true } } });
    const code = await runToken(["revoke", "agent:twin"], deps);
    expect(code).toBe(0);
    expect(JSON.parse(deps.calls[0]!.body)).toEqual({ agent_id: "twin" });
  });

  it("a { revoked: false } miss is a clean no-op (exit 0, no-oracle message)", async () => {
    const deps = makeDeps({ response: { status: 200, body: { revoked: false } } });
    const code = await runToken(["revoke", "deadbeef"], deps);
    expect(code).toBe(0);
    expect(deps.err.join("\n")).toMatch(/no matching/i);
  });

  it("rejects an empty agent:<id> target", async () => {
    const deps = makeDeps();
    const code = await runToken(["revoke", "agent:"], deps);
    expect(code).toBe(1);
    expect(deps.calls).toHaveLength(0);
  });
});

describe("runToken — rotate", () => {
  it("POSTs the target + the NEW identity and prints the new token once", async () => {
    const deps = makeDeps({
      response: { status: 201, body: { token: "tok_ROTATED", agent_id: "a", owner: "alice" } },
    });
    const code = await runToken(["rotate", "deadbeef", "--owner", "alice", "--agent", "a"], deps);
    expect(code).toBe(0);
    expect(deps.calls[0]!.url).toContain("/admin/tokens/rotate");
    expect(JSON.parse(deps.calls[0]!.body)).toEqual({
      digest: "deadbeef",
      agent_id: "a",
      owner: "alice",
    });
    expect(deps.out.filter((l) => l.includes("tok_ROTATED"))).toEqual(["tok_ROTATED"]);
    assertNoAdminLeak(deps);
  });

  it("rotate agent:<id> sends the by-agent target plus the new identity", async () => {
    const deps = makeDeps({
      response: { status: 201, body: { token: "tok_R", agent_id: "a", owner: "o" } },
    });
    await runToken(["rotate", "agent:twin", "--owner", "o", "--agent", "a"], deps);
    expect(JSON.parse(deps.calls[0]!.body)).toEqual({ agent_id: "a", owner: "o" });
  });

  it("rejects an empty agent:<id> rotate target before dialing", async () => {
    const deps = makeDeps();
    const code = await runToken(["rotate", "agent:", "--owner", "o", "--agent", "a"], deps);
    expect(code).toBe(1);
    expect(deps.calls).toHaveLength(0);
  });
});

describe("runToken — error paths are actionable and value-free", () => {
  it("401 → names every fix without echoing the admin token", async () => {
    const deps = makeDeps({ response: { status: 401, body: {} } });
    const code = await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(code).toBe(1);
    const msg = deps.err.join("\n");
    expect(msg).toContain("401");
    expect(msg).toContain(ADMIN_TOKEN_ENV);
    expect(msg).toMatch(/loopback/i);
    assertNoAdminLeak(deps);
  });

  it("400 → actionable invalid-request hint", async () => {
    const deps = makeDeps({ response: { status: 400, body: {} } });
    const code = await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(code).toBe(1);
    expect(deps.err.join("\n")).toContain("400");
  });

  it("404 → control surface not exposed", async () => {
    const deps = makeDeps({ response: { status: 404, body: {} } });
    const code = await runToken(["revoke", "x"], deps);
    expect(code).toBe(1);
    expect(deps.err.join("\n")).toContain("404");
  });

  it("an unexpected status is surfaced verbatim by code", async () => {
    const deps = makeDeps({ response: { status: 503, body: {} } });
    const code = await runToken(["revoke", "x"], deps);
    expect(code).toBe(1);
    expect(deps.err.join("\n")).toContain("503");
  });

  it("ECONNREFUSED → 'connection refused', names CAUCUS_URL, exits 1", async () => {
    const deps = makeDeps({
      fetchImpl: async () => {
        const e = new Error("fetch failed") as Error & { code?: string };
        e.code = "ECONNREFUSED";
        throw e;
      },
    });
    const code = await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(code).toBe(1);
    const msg = deps.err.join("\n");
    expect(msg).toMatch(/connection refused/i);
    expect(msg).toContain(URL_ENV);
    assertNoAdminLeak(deps);
  });

  it("a refused error nested under err.cause.code is still classified", async () => {
    const deps = makeDeps({
      fetchImpl: async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }),
        });
      },
    });
    const code = await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(code).toBe(1);
    expect(deps.err.join("\n")).toMatch(/connection refused/i);
  });

  it("a generic network failure → actionable 'cannot reach' error", async () => {
    const deps = makeDeps({
      fetchImpl: async () => {
        throw new Error("boom");
      },
    });
    const code = await runToken(["mint", "--owner", "o", "--agent", "a"], deps);
    expect(code).toBe(1);
    const msg = deps.err.join("\n");
    expect(msg).toMatch(/cannot reach the backbone/i);
    assertNoAdminLeak(deps);
  });
});
