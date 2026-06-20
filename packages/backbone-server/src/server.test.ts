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
import { createIssuer } from "./issuer.js";
import { parseTokenMap, tokenDigest } from "./tokens.js";
import { createHash } from "node:crypto";

/** Read a JSON response body as an arbitrary record (test-only convenience). */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** Matches any C0 (\x00–\x1f), DEL (\x7f), or C1 (\x80–\x9f) control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Token map + bearers for the write-route tests (CAU-13). Writes are now token-
 * gated and ANCHORED, so every write dispatch passes an {@link AuthContext}.
 * `tok-a` anchors to `{ agent_id: "a", owner: "alice" }` and `tok-b` to
 * `{ agent_id: "b", owner: "bob" }` — chosen to match the identities the
 * existing write tests already author, so anchoring is a no-op for them while
 * the gate is exercised.
 */
const TOKENS = parseTokenMap("tok-a:a:alice,tok-b:b:bob");
/** The unified issuer over the seed (CAU-20) — `dispatch` resolves through this. */
const ISSUER = createIssuer(TOKENS);
/** Authorized as alice (`agent_id "a"`, `owner "alice"`). */
const AUTH: AuthContext = { issuer: ISSUER, bearer: "tok-a" };
/** Authorized as bob (`agent_id "b"`, `owner "bob"`). */
const AUTH_B: AuthContext = { issuer: ISSUER, bearer: "tok-b" };
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

  // CAU-88: the MalformedPathError echoes the RAW, undecoded segment. llhttp
  // rejects control bytes in `req.url` before dispatch today, but that reopens
  // under insecureHTTPParser / a raw-forwarding proxy — so the segment passes
  // through the same strip-and-cap as every other caller-content echo.
  it("malformed-path 400 strips control bytes from the echoed raw segment (CAU-88)", async () => {
    const bb = await seeded();
    // A segment with a literal C1 (\x9b) + DEL (\x7f) AND invalid percent-encoding
    // (`%ZZ`) so decodeURIComponent throws and the raw segment is what's echoed.
    const dirty = `/channels/%ZZ\x9bevil\x7f`;
    const res = await dispatch(bb, "GET", dirty, undefined);
    expect(res.status).toBe(400);
    const body = res.json as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).not.toMatch(CONTROL_CHARS);
  });

  it("malformed-path 400 length-caps an overlong echoed segment (CAU-88)", async () => {
    const bb = await seeded();
    // Long, invalid-percent segment → the echoed fragment is capped (… marker).
    const longSeg = `%ZZ${"a".repeat(400)}`;
    const res = await dispatch(bb, "GET", `/channels/${longSeg}`, undefined);
    expect(res.status).toBe(400);
    const body = res.json as { error: { message: string } };
    expect(body.error.message).toContain("…");
    expect(body.error.message).not.toContain("a".repeat(400));
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

  it("describe with a control-byte name → 400 whose message echoes no control bytes (CAU-81)", async () => {
    // `\u009b` is C1 CSI — exactly what `GET /channels/%C2%9B…` decodes to,
    // and the byte JSON.stringify does NOT escape; `\x7f` is DEL (also
    // unescaped). Reachable tokenlessly, so the error message must be clean.
    const bb = new InMemoryBackbone();
    for (const name of ["\u009b31mevil", "del\x7fname", "esc\x1b[2Jname"]) {
      const res = await dispatch(
        bb,
        "GET",
        `/channels/${encodeURIComponent(name)}`,
        undefined,
      );
      expect(res.status).toBe(400);
      const body = res.json as { error: { code: string; message: string } };
      expect(body.error.code).toBe("invalid_channel_name");
      // eslint-disable-next-line no-control-regex -- intentionally matching control bytes
      expect(body.error.message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    }
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

  it("append with an over-cap to[] (33 recipients) → 400; response carries NO recipient values (CAU-90)", async () => {
    const bb = await seeded();
    // 33 > MAX_RECIPIENTS (32). Use a distinctive recipient token so we can
    // assert it never appears anywhere in the serialized error envelope.
    const RECIPIENT = "sentinel-recipient-xyz";
    const to = Array.from({ length: 33 }, () => RECIPIENT);
    const res = await dispatch(bb, "POST", "/channels/c1/append", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "fan-out",
      to,
    }, AUTH);
    expect(res.status).toBe(400);
    const body = res.json as {
      error: { code: string; issues?: string[] };
    };
    expect(body.error.code).toBe("invalid_message");
    expect(body.error.issues).toContain(
      "to[] has more than 32 recipients (33)",
    );
    // ADR-C12 / CAU-88: the full serialized envelope echoes the count/limit but
    // never a single recipient value.
    expect(JSON.stringify(res.json)).not.toContain(RECIPIENT);
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

describe("dispatch — reassign route assignee guard (CAU-18)", () => {
  /** A valid claim-message body (the holder's side of a reassign). */
  function reassignBody(target: string, over: Record<string, unknown> = {}) {
    return {
      type: "claim",
      agent_id: "a",
      owner: "alice",
      msg_id: newMsgId(),
      body: "reassigning",
      target,
      ...over,
    };
  }

  /** Seed `c1` and grant alice the `db` claim so a reassign is well-positioned. */
  async function seededWithClaim(): Promise<InMemoryBackbone> {
    const bb = await seeded();
    const granted = await dispatch(
      bb,
      "POST",
      "/channels/c1/claim",
      reassignBody("db", { body: "claiming" }),
      AUTH,
    );
    expect(granted.status).toBe(200);
    return bb;
  }

  it("missing assignee → 400 invalid_request, ledger unchanged (no silent self-reassign)", async () => {
    const bb = await seededWithClaim();
    const before = (await bb.describeChannel("c1")).head;
    // No `assignee` key in the body at all.
    const res = await dispatch(bb, "POST", "/channels/c1/reassign", reassignBody("db"), AUTH);
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_request" } });
    // Nothing appended — the reassign never reached the backbone.
    expect((await bb.describeChannel("c1")).head).toBe(before);
  });

  it("partial assignee (owner only, no agent_id) → 400 invalid_request, ledger unchanged", async () => {
    const bb = await seededWithClaim();
    const before = (await bb.describeChannel("c1")).head;
    const res = await dispatch(
      bb,
      "POST",
      "/channels/c1/reassign",
      reassignBody("db", { assignee: { owner: "bob" } }),
      AUTH,
    );
    expect(res.status).toBe(400);
    expect(res.json).toMatchObject({ error: { code: "invalid_request" } });
    expect((await bb.describeChannel("c1")).head).toBe(before);
  });

  it("a non-object / empty-string assignee → 400 invalid_request", async () => {
    const bb = await seededWithClaim();
    for (const assignee of [
      "bob",
      42,
      [],
      null,
      { agent_id: "", owner: "bob" },
      { agent_id: "b", owner: "" },
    ] as const) {
      const res = await dispatch(
        bb,
        "POST",
        "/channels/c1/reassign",
        reassignBody("db", { assignee }),
        AUTH,
      );
      expect(res.status).toBe(400);
      expect(res.json).toMatchObject({ error: { code: "invalid_request" } });
    }
  });

  it("a well-formed assignee → 200 granted (the guard does not reject valid input)", async () => {
    const bb = await seededWithClaim();
    const res = await dispatch(
      bb,
      "POST",
      "/channels/c1/reassign",
      reassignBody("db", { assignee: { agent_id: "b", owner: "bob" } }),
      AUTH,
    );
    expect(res.status).toBe(200);
    expect((res.json as { outcome: string }).outcome).toBe("granted");
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
      const res = await dispatch(bb, "POST", path, b, { issuer: ISSUER });
      expect(res.status).toBe(401);
      expect(res.json).toMatchObject({
        error: { code: "unauthorized", message: "missing or invalid token" },
      });
    }
  });

  it("a write with an UNKNOWN bearer → 401 with the IDENTICAL body (no oracle)", async () => {
    const bb = await seeded();
    const missing = await dispatch(bb, "POST", "/channels/c1/append", spoofedFinding(), {
      issuer: ISSUER,
    });
    const unknown = await dispatch(bb, "POST", "/channels/c1/append", spoofedFinding(), {
      issuer: ISSUER,
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

  it("GET /channels/%C2%9B… → 400 whose wire body carries no control bytes (CAU-81)", async () => {
    running = await startServer({ port: 0 });
    // Tokenless probe: %C2%9B decodes to the C1 CSI byte (which JSON.stringify
    // would NOT escape), %7F is DEL, %1B is C0 ESC. Without the CAU-81 strip
    // the C1/DEL bytes would ride the error message verbatim onto the wire.
    const res = await fetch(`${running.url}/channels/%C2%9B31mevil%7Fdel%1Besc`);
    expect(res.status).toBe(400);

    // Assert on the RAW WIRE BYTES, not a decoded convenience view: every body
    // byte must be printable ASCII (0x20–0x7e) — this catches raw C0/DEL/C1
    // bytes AND a UTF-8-encoded C1 (0xc2 0x9b would fail on the 0xc2).
    const raw = Buffer.from(await res.arrayBuffer());
    const offending = [...raw].filter((byte) => byte < 0x20 || byte > 0x7e);
    expect(offending).toEqual([]);

    // And the decoded body is still the well-formed, diagnosable wire error.
    const body = JSON.parse(raw.toString("utf8")) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("invalid_channel_name");
    expect(body.error.message).toContain("must match");
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

describe("artifact routes — raw-bytes PUT/GET (ADR-C14 / CAU-100)", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    if (running) {
      await running.close();
      running = undefined;
    }
  });

  /** lowercase-hex sha256 of bytes. */
  function sha(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  async function startWithChannel(): Promise<RunningServer> {
    const bb = new InMemoryBackbone();
    await bb.createChannel({ channel: "c1", purpose: "p", created_by: "alice" });
    return startServer({ port: 0, backbone: bb, tokens: TOKENS });
  }

  it("PUT is token-gated fail-closed: no token → 401, unknown token → identical 401 (no oracle)", async () => {
    running = await startWithChannel();
    const bytes = new Uint8Array(Buffer.from("evidence", "utf8"));
    const digest = sha(bytes);
    const url = `${running.url}/channels/c1/artifacts/${digest}`;

    const noAuth = await fetch(url, { method: "PUT", body: bytes });
    expect(noAuth.status).toBe(401);
    const noAuthBody = await noAuth.json();

    const badAuth = await fetch(url, {
      method: "PUT",
      headers: { authorization: "Bearer not-a-real-token" },
      body: bytes,
    });
    expect(badAuth.status).toBe(401);
    // Identical envelope for missing vs unknown — no oracle.
    expect(await badAuth.json()).toEqual(noAuthBody);

    // Nothing was stored (the GET is a 404).
    const get = await fetch(url);
    expect(get.status).toBe(404);
  });

  it("PUT new → 201 {uri,sha256,size}; identical re-PUT → 200 (idempotent dedup)", async () => {
    running = await startWithChannel();
    const bytes = new Uint8Array(Buffer.from("repro.sh contents", "utf8"));
    const digest = sha(bytes);
    const url = `${running.url}/channels/c1/artifacts/${digest}`;

    const first = await fetch(url, {
      method: "PUT",
      headers: BEARER_A,
      body: bytes,
    });
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({
      uri: `caucus://artifact/c1/${digest}`,
      sha256: digest,
      size: bytes.length,
    });

    const second = await fetch(url, {
      method: "PUT",
      headers: BEARER_A,
      body: bytes,
    });
    expect(second.status).toBe(200); // dedup hit
  });

  it("GET is tokenless within the boundary and serves raw application/octet-stream", async () => {
    running = await startWithChannel();
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0x7f, 0x80, 0x9b]); // binary-safe
    const digest = sha(bytes);
    const url = `${running.url}/channels/c1/artifacts/${digest}`;
    await fetch(url, { method: "PUT", headers: BEARER_A, body: bytes });

    // No Authorization header on the GET.
    const get = await fetch(url);
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("application/octet-stream");
    const got = new Uint8Array(await get.arrayBuffer());
    expect(Buffer.from(got).equals(Buffer.from(bytes))).toBe(true);
  });

  it("integrity mismatch (sha256(body) ≠ :sha256) → 400 artifact_integrity", async () => {
    running = await startWithChannel();
    const bytes = new Uint8Array(Buffer.from("real bytes", "utf8"));
    const wrong = sha(new Uint8Array(Buffer.from("other", "utf8")));
    const res = await fetch(`${running.url}/channels/c1/artifacts/${wrong}`, {
      method: "PUT",
      headers: BEARER_A,
      body: bytes,
    });
    expect(res.status).toBe(400);
    expect((await jsonBody(res)).error).toMatchObject({
      code: "artifact_integrity",
    });
  });

  it("GET of a missing blob (or unknown channel) → 404", async () => {
    running = await startWithChannel();
    const missing = "0".repeat(64);
    const known = await fetch(`${running.url}/channels/c1/artifacts/${missing}`);
    expect(known.status).toBe(404);
    const unknownChan = await fetch(
      `${running.url}/channels/nope/artifacts/${missing}`,
    );
    expect(unknownChan.status).toBe(404);
  });

  it("the raw-bytes PUT does NOT JSON-parse: a non-JSON binary body is stored verbatim", async () => {
    running = await startWithChannel();
    // A body that is NOT valid JSON (the JSON path would 400 invalid_json).
    const bytes = new Uint8Array(Buffer.from("{ not json at all \x00\xff", "binary"));
    const digest = sha(bytes);
    const put = await fetch(`${running.url}/channels/c1/artifacts/${digest}`, {
      method: "PUT",
      headers: BEARER_A,
      body: bytes,
    });
    expect(put.status).toBe(201); // stored, never JSON-parsed
    const got = new Uint8Array(
      await (await fetch(`${running.url}/channels/c1/artifacts/${digest}`)).arrayBuffer(),
    );
    expect(Buffer.from(got).equals(Buffer.from(bytes))).toBe(true);
  });

  it("a JSON body well over MAX_BODY_BYTES but under MAX_ARTIFACT_BYTES is NOT clamped by the 256KB cap", async () => {
    running = await startWithChannel();
    // 512KB — twice the JSON MAX_BODY_BYTES, well under the 1MiB artifact cap.
    const bytes = new Uint8Array(512 * 1024).fill(7);
    expect(bytes.length).toBeGreaterThan(MAX_BODY_BYTES);
    const digest = sha(bytes);
    const res = await fetch(`${running.url}/channels/c1/artifacts/${digest}`, {
      method: "PUT",
      headers: BEARER_A,
      body: bytes,
    });
    expect(res.status).toBe(201); // the JSON cap did not clamp the upload
  });

  it("an over-cap PUT is rejected MID-STREAM (413) with the socket destroyed, not fully buffered", async () => {
    running = await startWithChannel();
    const { port } = running;
    // Stream far MORE than MAX_ARTIFACT_BYTES and assert: (a) the server responds
    // 413 and (b) the request socket is destroyed before we finish sending — i.e.
    // the body is NOT buffered in full. We drive raw http so we can observe the
    // socket close and count bytes actually written.
    const result = await new Promise<{ status?: number; destroyedEarly: boolean }>(
      (resolve) => {
        const chunk = Buffer.alloc(64 * 1024, 1); // 64KB chunks
        // ~4 MiB total intended — 4x the cap.
        const totalChunks = (4 * 1024 * 1024) / chunk.length;
        let sent = 0;
        let status: number | undefined;
        let destroyedEarly = false;
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "PUT",
            path: `/channels/c1/artifacts/${"0".repeat(64)}`,
            headers: {
              authorization: "Bearer tok-a",
              "content-type": "application/octet-stream",
            },
          },
          (res) => {
            status = res.statusCode;
            res.resume();
          },
        );
        const pump = (): void => {
          if (sent >= totalChunks) {
            req.end();
            return;
          }
          sent++;
          // Once the server destroys the socket, further writes error out — which
          // is exactly the mid-stream cut we want to observe.
          const ok = req.write(chunk);
          if (ok) setImmediate(pump);
          else req.once("drain", pump);
        };
        req.on("error", () => {
          // ECONNRESET / EPIPE: the server destroyed the connection mid-upload
          // before we sent everything.
          if (sent < totalChunks) destroyedEarly = true;
          resolve({ status, destroyedEarly });
        });
        req.on("close", () => resolve({ status, destroyedEarly }));
        pump();
      },
    );
    // Either we observed the 413 response, or the socket was reset mid-stream
    // (both prove the over-cap upload was cut off, not buffered in full).
    expect(result.status === 413 || result.destroyedEarly).toBe(true);
  });

  it("a PUT over an UNKNOWN method on the artifact path → 405", async () => {
    running = await startWithChannel();
    const res = await fetch(
      `${running.url}/channels/c1/artifacts/${"0".repeat(64)}`,
      { method: "POST", headers: BEARER_A, body: new Uint8Array([1]) },
    );
    expect(res.status).toBe(405);
  });
});

/**
 * The issuer control surface (CAU-20). Mostly dispatch-level (the socket-free
 * pattern) with an admin AuthContext; the loopback-guard and a full
 * mint→use→revoke round-trip run over a real socket. The admin secret is
 * `admin-secret` (digest below); a regular write token (`tok-a`) must NEVER
 * satisfy the admin gate.
 */
const ADMIN_TOKEN = "admin-secret";
const ADMIN_DIGEST = tokenDigest(ADMIN_TOKEN);

/** A fresh issuer + admin AuthContext per test, so minted state never leaks across tests. */
function adminAuth(bearer: string): AuthContext {
  return {
    issuer: createIssuer(parseTokenMap("tok-a:a:alice,tok-b:b:bob")),
    bearer,
    adminTokenDigest: ADMIN_DIGEST,
  };
}

describe("issuer control routes (CAU-20) — dispatch level", () => {
  it("POST /admin/tokens mints 201 {token,agent_id,owner} and the token then authorizes an anchored append", async () => {
    const bb = await seeded();
    const auth = adminAuth(ADMIN_TOKEN);
    const mint = await dispatch(bb, "POST", "/admin/tokens", { agent_id: "x", owner: "xavier" }, auth);
    expect(mint.status).toBe(201);
    const body = mint.json as { token: string; agent_id: string; owner: string };
    expect(body.agent_id).toBe("x");
    expect(body.owner).toBe("xavier");
    expect(typeof body.token).toBe("string");

    // The minted token now authorizes an append, anchored to the minted identity
    // — even though the body claims to be someone else.
    const append = await dispatch(
      bb,
      "POST",
      "/channels/c1/append",
      { type: "finding", agent_id: "forged", owner: "forged", msg_id: newMsgId(), body: "hi" },
      { ...auth, bearer: body.token },
    );
    expect(append.status).toBe(201);
    expect((append.json as { message: { owner: string; agent_id: string } }).message).toMatchObject({
      owner: "xavier",
      agent_id: "x",
    });
  });

  it("mint WITHOUT the admin token → 401 (no-oracle), no token issued", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/admin/tokens", { agent_id: "x", owner: "x" }, adminAuth(undefined as unknown as string));
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ error: { code: "unauthorized", message: "missing or invalid token" } });
  });

  it("a REGULAR write token cannot mint → 401", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/admin/tokens", { agent_id: "x", owner: "x" }, adminAuth("tok-a"));
    expect(res.status).toBe(401);
    expect(res.json).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("admin DISABLED when no adminTokenDigest is configured → 401 even with a bearer", async () => {
    const bb = await seeded();
    const res = await dispatch(
      bb,
      "POST",
      "/admin/tokens",
      { agent_id: "x", owner: "x" },
      { issuer: createIssuer(new Map()), bearer: ADMIN_TOKEN },
    );
    expect(res.status).toBe(401);
  });

  it("a wrong admin token and a missing one are INDISTINGUISHABLE (no oracle)", async () => {
    const bb = await seeded();
    const missing = await dispatch(bb, "POST", "/admin/tokens", { agent_id: "x", owner: "x" }, { ...adminAuth(ADMIN_TOKEN), bearer: undefined });
    const wrong = await dispatch(bb, "POST", "/admin/tokens", { agent_id: "x", owner: "x" }, adminAuth("wrong-admin"));
    expect(missing.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(JSON.stringify(wrong.json)).toBe(JSON.stringify(missing.json));
  });

  it("revoke → the revoked token no longer authorizes an append (401)", async () => {
    const bb = await seeded();
    const auth = adminAuth(ADMIN_TOKEN);
    const mint = (await dispatch(bb, "POST", "/admin/tokens", { agent_id: "x", owner: "xavier" }, auth)).json as { token: string };
    // Works before revoke.
    const before = await dispatch(bb, "POST", "/channels/c1/append", { type: "finding", agent_id: "x", owner: "xavier", msg_id: newMsgId(), body: "a" }, { ...auth, bearer: mint.token });
    expect(before.status).toBe(201);
    // Revoke by agent_id.
    const rev = await dispatch(bb, "POST", "/admin/tokens/revoke", { agent_id: "x" }, auth);
    expect(rev.status).toBe(200);
    expect(rev.json).toEqual({ revoked: true });
    // Now the bearer 401s.
    const after = await dispatch(bb, "POST", "/channels/c1/append", { type: "finding", agent_id: "x", owner: "xavier", msg_id: newMsgId(), body: "b" }, { ...auth, bearer: mint.token });
    expect(after.status).toBe(401);
  });

  it("rotate → old token 401s, new token 201s", async () => {
    const bb = await seeded();
    const auth = adminAuth(ADMIN_TOKEN);
    const old = (await dispatch(bb, "POST", "/admin/tokens", { agent_id: "x", owner: "xavier" }, auth)).json as { token: string };
    const rotated = await dispatch(bb, "POST", "/admin/tokens/rotate", { agent_id: "x", owner: "xavier" }, auth);
    expect(rotated.status).toBe(201);
    const next = rotated.json as { token: string };
    expect(next.token).not.toBe(old.token);
    // Old bearer 401s.
    const oldAppend = await dispatch(bb, "POST", "/channels/c1/append", { type: "finding", agent_id: "x", owner: "xavier", msg_id: newMsgId(), body: "a" }, { ...auth, bearer: old.token });
    expect(oldAppend.status).toBe(401);
    // New bearer 201s, anchored.
    const newAppend = await dispatch(bb, "POST", "/channels/c1/append", { type: "finding", agent_id: "forged", owner: "forged", msg_id: newMsgId(), body: "b" }, { ...auth, bearer: next.token });
    expect(newAppend.status).toBe(201);
    expect((newAppend.json as { message: { owner: string } }).message.owner).toBe("xavier");
  });

  it("malformed mint/revoke bodies → value-free 400; the admin secret never appears in any error/response", async () => {
    const bb = await seeded();
    const auth = adminAuth(ADMIN_TOKEN);
    const badMint = await dispatch(bb, "POST", "/admin/tokens", { agent_id: "" }, auth);
    expect(badMint.status).toBe(400);
    const badRevoke = await dispatch(bb, "POST", "/admin/tokens/revoke", {}, auth);
    expect(badRevoke.status).toBe(400);
    // No echo of the admin secret in either body.
    expect(JSON.stringify(badMint.json)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(badRevoke.json)).not.toContain(ADMIN_TOKEN);
  });

  it("a successful mint/revoke response never echoes the admin secret", async () => {
    const bb = await seeded();
    const auth = adminAuth(ADMIN_TOKEN);
    const mint = await dispatch(bb, "POST", "/admin/tokens", { agent_id: "x", owner: "xavier" }, auth);
    const rev = await dispatch(bb, "POST", "/admin/tokens/revoke", { agent_id: "x" }, auth);
    expect(JSON.stringify(mint.json)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(rev.json)).not.toContain(ADMIN_TOKEN);
  });

  it("non-POST on the admin routes → 405; unknown admin sub-route → 404", async () => {
    const bb = await seeded();
    const auth = adminAuth(ADMIN_TOKEN);
    expect((await dispatch(bb, "GET", "/admin/tokens", undefined, auth)).status).toBe(405);
    expect((await dispatch(bb, "GET", "/admin/tokens/revoke", undefined, auth)).status).toBe(405);
    expect((await dispatch(bb, "POST", "/admin/tokens/bogus", {}, auth)).status).toBe(404);
  });

  it("loopback guard: the admin surface refuses off a non-loopback bind", async () => {
    const bb = await seeded();
    const res = await dispatch(
      bb,
      "POST",
      "/admin/tokens",
      { agent_id: "x", owner: "x" },
      { ...adminAuth(ADMIN_TOKEN), boundHost: "0.0.0.0" },
    );
    expect(res.status).toBe(401);
  });

  it("loopback guard: the admin surface STILL serves on boundHost localhost (config-supported loopback)", async () => {
    // config.ts treats HOST=localhost as a warning-free loopback bind; the admin
    // guard must accept it too, or HOST=localhost silently 401s the whole surface.
    const bb = await seeded();
    const res = await dispatch(
      bb,
      "POST",
      "/admin/tokens",
      { agent_id: "x", owner: "xavier" },
      { ...adminAuth(ADMIN_TOKEN), boundHost: "localhost" },
    );
    expect(res.status).toBe(201);
  });
});

describe("issuer control routes (CAU-20) — over a real socket", () => {
  let running: RunningServer | undefined;

  afterEach(async () => {
    if (running) {
      await running.close();
      running = undefined;
    }
  });

  it("mint → use → revoke → rejected, with anchored identity in the read-back", async () => {
    const bb = new InMemoryBackbone();
    await bb.createChannel({ channel: "c1", purpose: "p", created_by: "alice" });
    running = await startServer({
      port: 0,
      backbone: bb,
      tokens: TOKENS,
      adminTokenDigest: ADMIN_DIGEST,
    });

    // Mint a token for { x, xavier }.
    const mintRes = await fetch(`${running.url}/admin/tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ agent_id: "x", owner: "xavier" }),
    });
    expect(mintRes.status).toBe(201);
    const minted = (await mintRes.json()) as { token: string };

    // Use it to append, spoofing the body identity.
    const appendRes = await fetch(`${running.url}/channels/c1/append`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.token}` },
      body: JSON.stringify({ type: "finding", agent_id: "forged", owner: "forged", msg_id: newMsgId(), body: "from-minted" }),
    });
    expect(appendRes.status).toBe(201);

    // Read back: the stored identity is anchored to the minted identity, not the body.
    const readRes = await fetch(`${running.url}/channels/c1/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor: 0 }),
    });
    const log = (await readRes.json()) as { messages: { owner: string; agent_id: string }[] };
    const posted = log.messages.find((m) => m.agent_id === "x");
    expect(posted?.owner).toBe("xavier");

    // Revoke, then the same bearer is rejected.
    const revRes = await fetch(`${running.url}/admin/tokens/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` },
      body: JSON.stringify({ agent_id: "x" }),
    });
    expect(revRes.status).toBe(200);
    const after = await fetch(`${running.url}/channels/c1/append`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${minted.token}` },
      body: JSON.stringify({ type: "finding", agent_id: "x", owner: "xavier", msg_id: newMsgId(), body: "after-revoke" }),
    });
    expect(after.status).toBe(401);
  });

  it("a control op does NOT post to the channel log (ADR-C6)", async () => {
    const bb = new InMemoryBackbone();
    await bb.createChannel({ channel: "c1", purpose: "p", created_by: "alice" });
    running = await startServer({ port: 0, backbone: bb, tokens: TOKENS, adminTokenDigest: ADMIN_DIGEST });
    const head = (await bb.describeChannel("c1")).head;
    // Mint + revoke + rotate — none should append a message.
    await fetch(`${running.url}/admin/tokens`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ agent_id: "x", owner: "xavier" }) });
    await fetch(`${running.url}/admin/tokens/rotate`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ agent_id: "x", owner: "xavier" }) });
    await fetch(`${running.url}/admin/tokens/revoke`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ADMIN_TOKEN}` }, body: JSON.stringify({ agent_id: "x" }) });
    expect((await bb.describeChannel("c1")).head).toBe(head);
  });
});
