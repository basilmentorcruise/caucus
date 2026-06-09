/**
 * Unit tests for the pure {@link dispatch} router and the socket-bound
 * {@link createServer}/{@link startServer} lifecycle (CAU-5).
 *
 * `dispatch` is socket-free, so every route, method-guard, and not-found case is
 * exercised without a live server; the lifecycle tests cover ephemeral-port
 * binding, healthz, body parsing (invalid_json / payload_too_large), and that
 * `close()` frees the port.
 */
import { request as httpRequest } from "node:http";

import { InMemoryBackbone } from "@caucus/backbone";
import { newMsgId } from "@caucus/schema";
import { afterEach, describe, expect, it } from "vitest";

import {
  bindExposureWarning,
  createServer,
  dispatch,
  startServer,
  CONNECTIONS_CHECK_INTERVAL_MS,
  HEADERS_TIMEOUT_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  MAX_BODY_BYTES,
  REQUEST_TIMEOUT_MS,
  type AuthContext,
  type RunningServer,
} from "./server.js";
import { parseTokenMap } from "./tokens.js";

/** Read a JSON response body as an arbitrary record (test-only convenience). */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Token map + bearers for the write-route tests (CAU-13). Writes are now token-
 * gated and ANCHORED, so every write dispatch passes an {@link AuthContext}.
 * `tok-a` anchors to `{ agent_id: "a", owner: "alice" }` and `tok-b` to
 * `{ agent_id: "b", owner: "bob" }` — chosen to match the identities the
 * existing write tests already author, so anchoring is a no-op for them while
 * the gate is exercised.
 */
const TOKENS = parseTokenMap("tok-a:a:alice,tok-b:b:bob");
/** Authorized as alice (`agent_id "a"`, `owner "alice"`). */
const AUTH: AuthContext = { tokens: TOKENS, bearer: "tok-a" };
/** Authorized as bob (`agent_id "b"`, `owner "bob"`). */
const AUTH_B: AuthContext = { tokens: TOKENS, bearer: "tok-b" };
/** A valid Authorization header for the socket-level (fetch) write tests. */
const BEARER_A = { authorization: "Bearer tok-a" } as const;

/**
 * Issue a raw HTTP GET against `url` + `rawPath` using `node:http` (the `fetch`
 * URL parser rejects some malformed paths client-side; this sends the raw path
 * line to the server). Resolves with the status, or rejects on socket error —
 * a hang fails the test via the surrounding timeout.
 */
function rawGet(url: string, rawPath: string): Promise<number> {
  const { hostname, port } = new URL(url);
  return new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      { hostname, port, method: "GET", path: rawPath },
      (res) => {
        res.resume(); // drain so the socket can close
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** A backbone seeded with one channel `c1` for the routing tests. */
async function seeded(): Promise<InMemoryBackbone> {
  const bb = new InMemoryBackbone();
  await bb.createChannel({ channel: "c1", purpose: "p", created_by: "alice" });
  return bb;
}

describe("dispatch — routing", () => {
  it("GET /healthz → 200 { ok: true }", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "GET", "/healthz", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true });
  });

  it("POST /channels → 201 descriptor", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "POST", "/channels", {
      channel: "c1",
      purpose: "investigate",
      created_by: "alice",
    }, AUTH);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ channel: "c1", kind: "ephemeral" });
  });

  it("GET /channels → 200 { channels: [...] }", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "GET", "/channels", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ channels: [{ channel: "c1" }] });
  });

  it("GET /channels/:channel → 200 descriptor", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "GET", "/channels/c1", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ channel: "c1" });
  });

  it("POST /channels/:channel/subscribe → 200 { cursor }", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/subscribe", undefined);
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ cursor: 0 });
  });

  it("POST /channels/:channel/append → 201 AppendResult", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/append", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "found it",
    }, AUTH);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ cursor: 1, message: { body: "found it" } });
  });

  it("POST /channels/:channel/read → 200 ReadResult (with and without limit)", async () => {
    const bb = await seeded();
    await bb.append("c1", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "m1",
    });
    const all = await dispatch(bb, "POST", "/channels/c1/read", { cursor: 0 });
    expect(all.status).toBe(200);
    expect(all.json).toMatchObject({ cursor: 1 });

    const limited = await dispatch(bb, "POST", "/channels/c1/read", {
      cursor: 0,
      limit: 1,
    });
    expect(limited.status).toBe(200);
    expect((limited.json as { messages: unknown[] }).messages).toHaveLength(1);
  });

  it("POST /channels/:channel/read with no body defaults cursor to undefined → invalid_cursor 400", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/read", undefined);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_cursor" } });
  });

  it("POST /channels/:channel/claim → 200 granted (CAU-7)", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/claim", {
      type: "claim",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "claiming",
      target: "db",
    }, AUTH);
    expect(res.status).toBe(200);
    const result = res.json as {
      outcome: string;
      cursor: number;
      message: { type: string; target: string };
    };
    expect(result.outcome).toBe("granted");
    // ADR-C5: the granted claim is appended in the same atomic step, so the
    // head advances and the claim message is the new head.
    expect(result.cursor).toBe(1);
    expect(result.message.type).toBe("claim");
    expect(result.message.target).toBe("db");
  });

  it("percent-encoded channel segment is decoded before lookup", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "GET", "/channels/c1%2Fx", undefined);
    // decodes to "c1/x" which is an invalid slug → 400
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_channel_name" } });
  });

  it("query strings are stripped from the path", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "GET", "/healthz?ping=1", undefined);
    expect(res.status).toBe(200);
  });

  it("malformed percent-encoding in the path → 400 invalid_request (resolves, never throws)", async () => {
    const bb = await seeded();
    // `%ZZ` is not valid percent-encoding; decodeURIComponent throws URIError.
    // dispatch must RESOLVE to a clean 4xx, not reject.
    const res = await dispatch(bb, "GET", "/channels/%ZZ", undefined);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_request" } });
  });
});

describe("dispatch — request-body coercion (CAU-6)", () => {
  it("POST /channels with a missing / non-object body → 400 invalid_request", async () => {
    const bb = new InMemoryBackbone();
    for (const body of [undefined, 42, [], "str", null] as const) {
      const res = await dispatch(bb, "POST", "/channels", body);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("POST /channels/:c/append with a missing / non-object body → 400 invalid_request", async () => {
    const bb = await seeded();
    for (const body of [undefined, 42, [], "str", null] as const) {
      const res = await dispatch(bb, "POST", "/channels/c1/append", body);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("POST /channels/:c/read with no body defaults to {} → invalid_cursor 400 (locks current behavior)", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/read", undefined);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_cursor" } });
  });

  it("POST /channels/:c/read with a present non-object body → 400 invalid_request", async () => {
    const bb = await seeded();
    for (const body of [42, [], "str", null] as const) {
      const res = await dispatch(bb, "POST", "/channels/c1/read", body);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it('read with a bad limit (0 / -1 / 1.5 / "2") → 400 invalid_cursor', async () => {
    const bb = await seeded();
    for (const limit of [0, -1, 1.5, "2"] as const) {
      const res = await dispatch(bb, "POST", "/channels/c1/read", {
        cursor: 0,
        limit,
      });
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: { code: "invalid_cursor" } });
    }
  });

  it("read with a valid limit on a multi-message log → limited slice + advanced cursor", async () => {
    const bb = await seeded();
    for (let i = 0; i < 5; i += 1) {
      await bb.append("c1", {
        type: "finding",
        agent_id: "a",
        owner: "alice",
        msg_id: newMsgId(),
        body: `m${i}`,
      });
    }
    const res = await dispatch(bb, "POST", "/channels/c1/read", {
      cursor: 0,
      limit: 2,
    });
    expect(res.status).toBe(200);
    const result = res.json as { messages: unknown[]; cursor: number };
    expect(result.messages).toHaveLength(2);
    expect(result.cursor).toBe(2);
  });

  it("a valid createChannel / append body still succeeds (happy-path regression)", async () => {
    const bb = new InMemoryBackbone();
    const created = await dispatch(bb, "POST", "/channels", {
      channel: "c1",
      purpose: "p",
      created_by: "alice",
    }, AUTH);
    expect(created.status).toBe(201);
    const appended = await dispatch(bb, "POST", "/channels/c1/append", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "found it",
    }, AUTH);
    expect(appended.status).toBe(201);
    expect(appended.json).toMatchObject({ cursor: 1 });
  });
});

describe("dispatch — not found / method not allowed", () => {
  it("unknown top-level path → 404 not_found", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "GET", "/nope", undefined);
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: { code: "not_found" } });
  });

  it("unknown channel sub-action → 404 not_found", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/frobnicate", {});
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: { code: "not_found" } });
  });

  it("deep unknown path → 404 not_found", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "GET", "/channels/c1/append/extra", undefined);
    expect(res.status).toBe(404);
  });

  it("wrong method on /healthz → 405", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "POST", "/healthz", undefined);
    expect(res.status).toBe(405);
    expect(res.json).toMatchObject({ error: { code: "method_not_allowed" } });
  });

  it("wrong method on /channels → 405", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "DELETE", "/channels", undefined);
    expect(res.status).toBe(405);
  });

  it("wrong method on /channels/:channel → 405", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "DELETE", "/channels/c1", undefined);
    expect(res.status).toBe(405);
  });

  it("wrong method on a sub-action → 405", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "GET", "/channels/c1/subscribe", undefined);
    expect(res.status).toBe(405);
  });
});

describe("dispatch — backbone errors map cleanly", () => {
  it("createChannel duplicate → 409 channel_exists", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels", {
      channel: "c1",
      purpose: "p",
      created_by: "alice",
    }, AUTH);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: { code: "channel_exists" } });
  });

  it("createChannel with a NON-STRING purpose → 400 invalid_message; list stays healthy", async () => {
    // The transport's body guard only checks the envelope is an object, so an
    // array `purpose` reaches the backbone. It must be rejected at the write —
    // a stored non-string would make GET /channels throw in the read-side
    // sanitizer for every principal until restart.
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels", {
      channel: "c2",
      purpose: ["\x1b[2J boom"],
      created_by: "alice",
    }, AUTH);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_message" } });

    // No poisoning: the listing route still serves, and c2 was never created.
    const list = await dispatch(bb, "GET", "/channels", undefined);
    expect(list.status).toBe(200);
    expect(list.json).toMatchObject({ channels: [{ channel: "c1" }] });
  });

  it("describe unknown channel → 404 unknown_channel", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "GET", "/channels/ghost", undefined);
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: { code: "unknown_channel" } });
  });

  it("append with bad message → 400 invalid_message with issues", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/append", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: "not-a-ulid",
      body: "x",
    }, AUTH);
    expect(res.status).toBe(400);
    const body = res.json as { error: { code: string; issues?: string[] } };
    expect(body.error.code).toBe("invalid_message");
    expect(Array.isArray(body.error.issues)).toBe(true);
  });
});

describe("dispatch — claim route (CAU-7)", () => {
  /** A valid claim message body for `target`. */
  function claimBody(target: string, over: Record<string, unknown> = {}) {
    return {
      type: "claim",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "claiming",
      target,
      ...over,
    };
  }

  it("conflict is a 200 `already_claimed` RESULT carrying the holder, NOT an error envelope", async () => {
    const bb = await seeded();
    const first = await dispatch(bb, "POST", "/channels/c1/claim", claimBody("db"), AUTH);
    expect(first.status).toBe(200);
    expect((first.json as { outcome: string }).outcome).toBe("granted");

    // A second claim on the same target loses first-write-wins. The HTTP layer
    // must surface this as a normal 200 value (the client maps it as a result,
    // never a throw), and the value must identify the holder. The second claim
    // authenticates as bob (anchored from its own bearer).
    const second = await dispatch(
      bb,
      "POST",
      "/channels/c1/claim",
      claimBody("db", { agent_id: "b", owner: "bob" }),
      AUTH_B,
    );
    expect(second.status).toBe(200);
    const body = second.json as {
      outcome: string;
      by?: { agent_id: string; owner: string; ts: string; msg_id: string };
      error?: unknown;
    };
    expect(body.error).toBeUndefined();
    expect(body.outcome).toBe("already_claimed");
    expect(body.by).toMatchObject({ agent_id: "a", owner: "alice" });
    expect(typeof body.by?.ts).toBe("string");
    expect(typeof body.by?.msg_id).toBe("string");
  });

  it("non-object claim body → 400 invalid_request (structural guard)", async () => {
    const bb = await seeded();
    for (const b of [undefined, 42, [], "str", null] as const) {
      const res = await dispatch(bb, "POST", "/channels/c1/claim", b);
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("malformed claim message → 400 invalid_message with issues", async () => {
    const bb = await seeded();
    const res = await dispatch(
      bb,
      "POST",
      "/channels/c1/claim",
      claimBody("db", { msg_id: "not-a-ulid" }),
      AUTH,
    );
    expect(res.status).toBe(400);
    const body = res.json as { error: { code: string; issues?: string[] } };
    expect(body.error.code).toBe("invalid_message");
    expect(Array.isArray(body.error.issues)).toBe(true);
  });

  it("claim on an unknown channel → 404 unknown_channel", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "POST", "/channels/ghost/claim", claimBody("db"), AUTH);
    expect(res.status).toBe(404);
    expect(res.json).toMatchObject({ error: { code: "unknown_channel" } });
  });

  it("a `claim`-typed message via /append is rejected (locks the transport split)", async () => {
    // ADR-C5: claim messages must go through claim(), never append(). The
    // backbone enforces this; this test locks that the HTTP append route does
    // NOT become a side door for minting claim messages.
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/append", claimBody("db"), AUTH);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_message" } });
  });
});

describe("dispatch — identity anchoring + auth gate (CAU-13)", () => {
  /** A finding body that SPOOFS mallory — the server must overwrite it. */
  function spoofedFinding(over: Record<string, unknown> = {}) {
    return {
      type: "finding",
      agent_id: "mallory-agent",
      owner: "mallory",
      msg_id: newMsgId(),
      body: "spoof",
      ...over,
    };
  }
  function spoofedClaim(target: string) {
    return {
      type: "claim",
      agent_id: "mallory-agent",
      owner: "mallory",
      msg_id: newMsgId(),
      body: "claiming",
      target,
    };
  }

  it("append OVERWRITES a spoofed agent_id/owner with the token's identity", async () => {
    const bb = await seeded();
    // Spy on what the backbone actually receives.
    const captured: { agent_id: string; owner: string }[] = [];
    const orig = bb.append.bind(bb);
    bb.append = async (channel, msg) => {
      captured.push({ agent_id: msg.agent_id, owner: msg.owner });
      return orig(channel, msg);
    };

    const res = await dispatch(bb, "POST", "/channels/c1/append", spoofedFinding(), AUTH);
    expect(res.status).toBe(201);
    // Backbone saw the ANCHORED identity, never the spoofed one.
    expect(captured).toEqual([{ agent_id: "a", owner: "alice" }]);
    expect((res.json as { message: { owner: string } }).message.owner).toBe("alice");
  });

  it("claim OVERWRITES a spoofed agent_id/owner with the token's identity", async () => {
    const bb = await seeded();
    const captured: { agent_id: string; owner: string }[] = [];
    const orig = bb.claim.bind(bb);
    bb.claim = async (channel, msg) => {
      captured.push({ agent_id: msg.agent_id, owner: msg.owner });
      return orig(channel, msg);
    };

    const res = await dispatch(bb, "POST", "/channels/c1/claim", spoofedClaim("db"), AUTH);
    expect(res.status).toBe(200);
    expect(captured).toEqual([{ agent_id: "a", owner: "alice" }]);
  });

  it("createChannel anchors created_by to the token's owner (overwrites spoof)", async () => {
    const bb = new InMemoryBackbone();
    const res = await dispatch(bb, "POST", "/channels", {
      channel: "c1",
      purpose: "p",
      created_by: "mallory",
    }, AUTH);
    expect(res.status).toBe(201);
    expect((res.json as { created_by: string }).created_by).toBe("alice");
  });

  it("does not MUTATE the parsed body (anchoring builds a new object)", async () => {
    const bb = await seeded();
    const body = spoofedFinding();
    await dispatch(bb, "POST", "/channels/c1/append", body, AUTH);
    // The caller's object is untouched — only a copy was anchored.
    expect(body.agent_id).toBe("mallory-agent");
    expect(body.owner).toBe("mallory");
  });

  it("a write with a MISSING bearer → 401 unauthorized", async () => {
    const bb = await seeded();
    for (const [path, b] of [
      ["/channels", { channel: "x", purpose: "p", created_by: "a" }],
      ["/channels/c1/append", spoofedFinding()],
      ["/channels/c1/claim", spoofedClaim("db")],
    ] as const) {
      const res = await dispatch(bb, "POST", path, b, { tokens: TOKENS });
      expect(res.status).toBe(401);
      expect(res.json).toMatchObject({
        error: { code: "unauthorized", message: "missing or invalid token" },
      });
    }
  });

  it("a write with an UNKNOWN bearer → 401 with the IDENTICAL body (no oracle)", async () => {
    const bb = await seeded();
    const missing = await dispatch(bb, "POST", "/channels/c1/append", spoofedFinding(), {
      tokens: TOKENS,
    });
    const unknown = await dispatch(bb, "POST", "/channels/c1/append", spoofedFinding(), {
      tokens: TOKENS,
      bearer: "not-a-real-token",
    });
    expect(missing.status).toBe(401);
    expect(unknown.status).toBe(401);
    // Byte-identical envelopes — the response cannot distinguish the two.
    expect(JSON.stringify(unknown.json)).toBe(JSON.stringify(missing.json));
  });

  it("fail-closed: with NO token map every write is 401", async () => {
    const bb = await seeded();
    // No `tokens` and a (would-be valid) bearer: still 401, because the empty
    // map authorizes nobody.
    const res = await dispatch(bb, "POST", "/channels/c1/append", spoofedFinding(), {
      bearer: "tok-a",
    });
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("reads and healthz are tokenless even on a gated server", async () => {
    const bb = await seeded();
    // GET describe, GET list, POST subscribe, POST read, GET healthz — no auth.
    expect((await dispatch(bb, "GET", "/channels/c1", undefined)).status).toBe(200);
    expect((await dispatch(bb, "GET", "/channels", undefined)).status).toBe(200);
    expect((await dispatch(bb, "POST", "/channels/c1/subscribe", undefined)).status).toBe(200);
    expect((await dispatch(bb, "POST", "/channels/c1/read", { cursor: 0 })).status).toBe(200);
    expect((await dispatch(bb, "GET", "/healthz", undefined)).status).toBe(200);
  });

  it("over a real socket: write requires a Bearer header; reads do not (CAU-13)", async () => {
    const bb = await seeded();
    const srv = await startServer({ port: 0, backbone: bb, tokens: TOKENS });
    try {
      // No header → 401.
      const noAuth = await fetch(`${srv.url}/channels/c1/append`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(spoofedFinding()),
      });
      expect(noAuth.status).toBe(401);

      // Case-insensitive `bearer ` prefix is accepted; identity is anchored.
      const ok = await fetch(`${srv.url}/channels/c1/append`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "bearer tok-a" },
        body: JSON.stringify(spoofedFinding()),
      });
      expect(ok.status).toBe(201);
      expect(((await ok.json()) as { message: { owner: string } }).message.owner).toBe("alice");

      // Read is open with no header.
      const read = await fetch(`${srv.url}/channels/c1/read`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cursor: 0 }),
      });
      expect(read.status).toBe(200);
    } finally {
      await srv.close();
    }
  });
});

describe("server lifecycle (sockets)", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    if (running) {
      await running.close();
      running = undefined;
    }
  });

  it("startServer binds an ephemeral port and serves /healthz", async () => {
    running = await startServer({ port: 0 });
    expect(running.port).toBeGreaterThan(0);
    expect(running.url).toContain(`:${running.port}`);

    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("round-trips create → describe over a real socket", async () => {
    running = await startServer({ port: 0, tokens: TOKENS });
    const create = await fetch(`${running.url}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", ...BEARER_A },
      body: JSON.stringify({ channel: "live", purpose: "p", created_by: "alice" }),
    });
    expect(create.status).toBe(201);
    const describe = await fetch(`${running.url}/channels/live`);
    expect(describe.status).toBe(200);
    expect((await jsonBody(describe)).channel).toBe("live");
  });

  it("malformed JSON body → 400 invalid_json", async () => {
    running = await startServer({ port: 0 });
    const res = await fetch(`${running.url}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error).toMatchObject({ code: "invalid_json" });
  });

  it("oversized body → 413 payload_too_large", async () => {
    running = await startServer({ port: 0 });
    const huge = "x".repeat(MAX_BODY_BYTES + 1024);
    const res = await fetch(`${running.url}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "c", purpose: huge, created_by: "a" }),
    });
    expect(res.status).toBe(413);
    expect((await jsonBody(res)).error).toMatchObject({ code: "payload_too_large" });
  });

  it("empty-body POST is handled (parsed as undefined) — read with no body → 400", async () => {
    running = await startServer({ port: 0, tokens: TOKENS });
    await fetch(`${running.url}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", ...BEARER_A },
      body: JSON.stringify({ channel: "c1", purpose: "p", created_by: "a" }),
    });
    // Read is tokenless even on a token-gated server.
    const res = await fetch(`${running.url}/channels/c1/read`, { method: "POST" });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error).toMatchObject({ code: "invalid_cursor" });
  });

  it("uses a supplied backbone instance", async () => {
    const bb = await seeded();
    running = await startServer({ port: 0, backbone: bb });
    const res = await fetch(`${running.url}/channels/c1`);
    expect(res.status).toBe(200);
    expect((await jsonBody(res)).channel).toBe("c1");
  });

  it("close() frees the port (a second bind on the same port succeeds)", async () => {
    const first = await startServer({ port: 0 });
    const port = first.port;
    await first.close();
    // Re-binding the just-freed port must succeed.
    const second = await startServer({ port });
    expect(second.port).toBe(port);
    await second.close();
  });

  it("malformed percent-encoding path → real HTTP response, never hangs", async () => {
    running = await startServer({ port: 0 });
    // Before the fix this dropped the response (unhandled URIError) and the
    // socket hung; now it must return a 4xx. The 2s timeout catches a regression.
    const status = await rawGet(running.url, "/channels/%ZZ");
    expect(status).toBe(400);
  }, 2000);

  it("createServer returns an http.Server that is not yet listening", () => {
    const server = createServer();
    expect(server.listening).toBe(false);
    server.close();
  });

  it("createServer pins the slowloris timeout knobs (CAU-75)", () => {
    // The contract is "the knobs are set" — no live slow-client probe (flaky
    // and slow); Node's own machinery enforces the timeouts once configured.
    const server = createServer();
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.requestTimeout).toBe(REQUEST_TIMEOUT_MS);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    // Passed as a creation option; Node stores it as a runtime instance
    // property that @types/node does not declare, hence Reflect.get.
    expect(Reflect.get(server, "connectionsCheckingInterval")).toBe(
      CONNECTIONS_CHECK_INTERVAL_MS,
    );
    // The header window must close before the whole-request window.
    expect(HEADERS_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS);
    server.close();
  });

  it("HOST=0.0.0.0 (wildcard) → a dialable 127.0.0.1 URL (CAU-75)", async () => {
    running = await startServer({ port: 0, host: "0.0.0.0" });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // The URL substitution must never MASK exposure: the real bind stays
    // visible as boundHost, and it maps to the startup warning the bin prints.
    expect(running.boundHost).toBe("0.0.0.0");
    expect(bindExposureWarning(running.boundHost)).toContain("bound to 0.0.0.0");
    // Empirical dialability: the substituted loopback URL actually answers.
    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);
  });

  it('HOST="::" (IPv6 wildcard) → a dialable http://[::1]:<port> URL (CAU-75)', async () => {
    // Skip-if-listen-fails guard: some runners have no IPv6 stack.
    try {
      running = await startServer({ port: 0, host: "::" });
    } catch {
      return;
    }
    expect(running.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
    expect(running.boundHost).toBe("::");
    const res = await fetch(`${running.url}/healthz`);
    expect(res.status).toBe(200);
  });

  it('HOST="::1" stays bracketed in the URL', async () => {
    try {
      running = await startServer({ port: 0, host: "::1" });
    } catch {
      return;
    }
    expect(running.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
  });

  it("default host yields the unchanged 127.0.0.1 URL", async () => {
    running = await startServer({ port: 0 });
    expect(running.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(running.boundHost).toBe("127.0.0.1");
  });
});

describe("bindExposureWarning (CAU-75 — the startup log never masks a wide bind)", () => {
  it("loopback binds → no warning", () => {
    expect(bindExposureWarning("127.0.0.1")).toBeUndefined();
    expect(bindExposureWarning("::1")).toBeUndefined();
  });

  it("wildcard binds → a warning naming the real bind and SECURITY.md", () => {
    const v4 = bindExposureWarning("0.0.0.0");
    expect(v4).toBe(
      "WARNING: bound to 0.0.0.0 — reads are open to anyone who can reach this port (see SECURITY.md)",
    );
    const v6 = bindExposureWarning("::");
    expect(v6).toContain("bound to ::");
    expect(v6).toContain("SECURITY.md");
  });

  it("a specific non-loopback interface → a warning too", () => {
    expect(bindExposureWarning("192.168.1.5")).toContain("bound to 192.168.1.5");
  });
});

describe("dispatch — CAU-74 resource caps over the wire", () => {
  it("an append on a full channel → 409 channel_full envelope", async () => {
    const bb = new InMemoryBackbone({ maxMessagesPerChannel: 1 });
    await bb.createChannel({ channel: "c1", purpose: "p", created_by: "alice" });
    await bb.append("c1", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "filler",
    });
    const res = await dispatch(bb, "POST", "/channels/c1/append", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "over the cap",
    }, AUTH);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: { code: "channel_full" } });
    // The envelope names the channel and the cap — never the rejected body.
    const message = (res.json as { error: { message: string } }).error.message;
    expect(message).toContain('"c1"');
    expect(message).toContain("at most 1 message.");
    expect(message).not.toContain("over the cap");
  });

  it("a create past maxChannels → 409 channel_limit envelope", async () => {
    const bb = new InMemoryBackbone({ maxChannels: 1 });
    await bb.createChannel({ channel: "c1", purpose: "p", created_by: "alice" });
    const res = await dispatch(bb, "POST", "/channels", {
      channel: "c2",
      purpose: "p",
    }, AUTH);
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: { code: "channel_limit" } });
  });

  it("a throttled create → 429 rate_limited envelope (create scope message)", async () => {
    const bb = new InMemoryBackbone({ maxChannelCreatesPerMinute: 1 });
    const first = await dispatch(bb, "POST", "/channels", {
      channel: "c1",
      purpose: "p",
    }, AUTH);
    expect(first.status).toBe(201);
    const second = await dispatch(bb, "POST", "/channels", {
      channel: "c2",
      purpose: "p",
    }, AUTH);
    expect(second.status).toBe(429);
    expect(second.json).toMatchObject({ error: { code: "rate_limited" } });
    expect((second.json as { error: { message: string } }).error.message).toContain(
      "channel creates/min per owner",
    );
  });
});
