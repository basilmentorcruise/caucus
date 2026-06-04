/**
 * Unit tests for the pure {@link dispatch} router and the socket-bound
 * {@link createServer}/{@link startServer} lifecycle (CAU-5).
 *
 * `dispatch` is socket-free, so every route, method-guard, and not-found case is
 * exercised without a live server; the lifecycle tests cover ephemeral-port
 * binding, healthz, body parsing (invalid_json / payload_too_large), and that
 * `close()` frees the port.
 */
import { InMemoryBackbone } from "@caucus/backbone";
import { newMsgId } from "@caucus/schema";
import { afterEach, describe, expect, it } from "vitest";

import {
  createServer,
  dispatch,
  startServer,
  MAX_BODY_BYTES,
  type RunningServer,
} from "./server.js";

/** Read a JSON response body as an arbitrary record (test-only convenience). */
async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
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
    });
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
    });
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

  it("POST /channels/:channel/claim → 501 not_implemented (CAU-7)", async () => {
    const bb = await seeded();
    const res = await dispatch(bb, "POST", "/channels/c1/claim", {
      type: "claim",
      agent_id: "a",
      owner: "alice",
      msg_id: "01HZZZZZZZZZZZZZZZZZZZZZZZZ",
      body: "claiming",
      target: "t",
    });
    expect(res.status).toBe(501);
    expect(res.json).toMatchObject({ error: { code: "not_implemented" } });
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
    });
    expect(res.status).toBe(409);
    expect(res.json).toMatchObject({ error: { code: "channel_exists" } });
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
    });
    expect(res.status).toBe(400);
    const body = res.json as { error: { code: string; issues?: string[] } };
    expect(body.error.code).toBe("invalid_message");
    expect(Array.isArray(body.error.issues)).toBe(true);
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
    running = await startServer({ port: 0 });
    const create = await fetch(`${running.url}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    running = await startServer({ port: 0 });
    await fetch(`${running.url}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel: "c1", purpose: "p", created_by: "a" }),
    });
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

  it("createServer returns an http.Server that is not yet listening", () => {
    const server = createServer();
    expect(server.listening).toBe(false);
    server.close();
  });
});
