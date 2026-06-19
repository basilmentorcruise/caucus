/**
 * Integration scenario — the read-only SSE log-tail (ADR-C15 / CAU-17)
 * end-to-end over a REAL backbone-server process.
 *
 * Boots the backbone-server bin on an ephemeral port (token-gated, CAU-13),
 * opens `GET /channels/:channel/stream` with a raw HTTP client, appends through
 * the real write path (an `HttpBackbone` carrying a bearer), and asserts the
 * sanitized frame arrives within ~one poll interval. It also validates every
 * route AC the issue calls out against the wire:
 *
 *  - live delivery + frame byte-identical to the `readSince` read path (AC2/AC3);
 *  - `?since=<cursor>` replay with no dup/skip (AC3);
 *  - the 33rd concurrent stream → 503 (AC5b);
 *  - a `POST` to the stream path → 405 (AC1);
 *  - an unknown channel → 404, an existing-but-empty channel → 200-open (AC6);
 *  - the JSON routes keep their CAU-75 slowloris timeouts — a trickle on a JSON
 *    route still times out while a held-open stream stays open (AC5a/AC5c).
 *
 * SSE connections are leak-prone: every opened stream/probe is destroyed in a
 * `finally` and the server process is stopped in `afterAll`.
 */
import { request as httpRequest } from "node:http";

import { HttpBackbone, MAX_CONCURRENT_STREAMS } from "@caucus/backbone-server";
import { newMsgId, sanitizeMessageFields } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServerProcess, type ServerProcess } from "../harness.js";

const TOK = "tok-alice-secret";
const SERVER_TOKENS = `${TOK}:alice-agent:alice`;
const CHANNEL = "incident-stream";

/** Matches any C0/DEL/C1 control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

/** Open an SSE stream over node:http; collect frames; abort destroys the socket. */
interface SseHandle {
  readonly status: number;
  readonly frames: () => unknown[];
  readonly raw: () => string;
  readonly abort: () => void;
}

function openSse(url: string, path: string): Promise<SseHandle> {
  const { hostname, port } = new URL(url);
  return new Promise<SseHandle>((resolve, reject) => {
    const req = httpRequest(
      { hostname, port, method: "GET", path, headers: { accept: "text/event-stream" } },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buf += chunk;
        });
        res.on("error", () => {
          /* torn down by abort() */
        });
        const frames = (): unknown[] =>
          buf
            .split("\n\n")
            .map((block) =>
              block.split("\n").find((l) => l.startsWith("data: ")),
            )
            .filter((l): l is string => l !== undefined)
            .map((l) => JSON.parse(l.slice("data: ".length)));
        resolve({
          status: res.statusCode ?? 0,
          frames,
          raw: () => buf,
          abort: () => req.destroy(),
        });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNRESET") return;
      reject(err);
    });
    req.end();
  });
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 3_000,
  stepMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((r) => setTimeout(r, stepMs));
  }
  if (!predicate()) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("CAU-17 — read-only SSE log-tail over a real server process (ADR-C15)", () => {
  let server: ServerProcess;
  let client: HttpBackbone;

  beforeAll(async () => {
    server = await startServerProcess({ CAUCUS_TOKENS: SERVER_TOKENS });
    client = new HttpBackbone(server.url, { token: TOK });
    await client.createChannel({
      channel: CHANNEL,
      purpose: "stream test",
      created_by: "alice",
    });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("AC2/AC3 — a message appended after connect arrives, frame byte-identical to readSince", async () => {
    const sse = await openSse(server.url, `/channels/${CHANNEL}/stream`);
    try {
      expect(sse.status).toBe(200);
      const appended = await client.append(CHANNEL, {
        type: "finding",
        agent_id: "alice-agent",
        owner: "alice",
        msg_id: newMsgId(),
        body: "live over the wire",
      });
      await waitFor(() => sse.frames().length >= 1);
      const frame = sse.frames()[0];
      const { messages } = await client.readSince(CHANNEL, appended.cursor - 1);
      // Byte-identical to the read path (same shared sanitizer — ADR-C15) and
      // control-byte free in the delivered frame.
      expect(JSON.stringify(frame)).toBe(
        JSON.stringify(sanitizeMessageFields(messages[0]!)),
      );
      expect(JSON.stringify(frame)).not.toMatch(CONTROL_CHARS);
    } finally {
      sse.abort();
    }
  });

  it("AC3 — ?since=<cursor> replays from the cursor with no dup/skip", async () => {
    // head is currently 1 (one message from the prior test). Append two more.
    const before = (await client.describeChannel(CHANNEL)).head;
    for (const body of ["s1", "s2"]) {
      await client.append(CHANNEL, {
        type: "note",
        agent_id: "alice-agent",
        owner: "alice",
        msg_id: newMsgId(),
        body,
      });
    }
    const sse = await openSse(
      server.url,
      `/channels/${CHANNEL}/stream?since=${before}`,
    );
    try {
      expect(sse.status).toBe(200);
      await waitFor(() => sse.frames().length >= 2);
      await client.append(CHANNEL, {
        type: "note",
        agent_id: "alice-agent",
        owner: "alice",
        msg_id: newMsgId(),
        body: "s3",
      });
      await waitFor(() => sse.frames().length >= 3);
      const bodies = sse.frames().map((f) => (f as { body: string }).body);
      expect(bodies).toEqual(["s1", "s2", "s3"]);
    } finally {
      sse.abort();
    }
  });

  it("AC3 — a malformed ?since → 400", async () => {
    const res = await fetch(`${server.url}/channels/${CHANNEL}/stream?since=nope`);
    expect(res.status).toBe(400);
    await res.body?.cancel();
  });

  it("AC1 — a POST to the stream path → 405; opening posts nothing", async () => {
    const headBefore = (await client.describeChannel(CHANNEL)).head;
    const post = await fetch(`${server.url}/channels/${CHANNEL}/stream`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOK}` },
    });
    expect(post.status).toBe(405);
    await post.body?.cancel();
    // Open + close a stream; head must be unchanged (read-only).
    const sse = await openSse(server.url, `/channels/${CHANNEL}/stream`);
    sse.abort();
    const headAfter = (await client.describeChannel(CHANNEL)).head;
    expect(headAfter).toBe(headBefore);
  });

  it("AC6 — unknown channel → 404; existing-but-empty → 200 open and silent", async () => {
    const unknown = await fetch(`${server.url}/channels/never-made/stream`);
    expect(unknown.status).toBe(404);
    await unknown.body?.cancel();

    await client.createChannel({
      channel: "empty-stream",
      purpose: "p",
      created_by: "alice",
    });
    const sse = await openSse(server.url, "/channels/empty-stream/stream");
    try {
      expect(sse.status).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 300));
      expect(sse.frames()).toHaveLength(0); // open but silent
      await client.append("empty-stream", {
        type: "note",
        agent_id: "alice-agent",
        owner: "alice",
        msg_id: newMsgId(),
        body: "first",
      });
      await waitFor(() => sse.frames().length >= 1);
      expect((sse.frames()[0] as { body: string }).body).toBe("first");
    } finally {
      sse.abort();
    }
  });

  it("AC5b — the 33rd concurrent stream → 503 (global capacity)", async () => {
    const open: SseHandle[] = [];
    try {
      for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
        const sse = await openSse(server.url, `/channels/${CHANNEL}/stream`);
        expect(sse.status).toBe(200);
        open.push(sse);
      }
      const overflow = await fetch(`${server.url}/channels/${CHANNEL}/stream`);
      expect(overflow.status).toBe(503);
      const body = (await overflow.json()) as { error: { code: string } };
      expect(body.error.code).toBe("stream_capacity");
    } finally {
      for (const sse of open) sse.abort();
    }
    // Let the server observe the closes so later tests have free slots.
    await new Promise<void>((r) => setTimeout(r, 300));
  }, 20_000);

  it("AC5a/AC5c — the stream is exempt from the CAU-75 timeouts (survives past the headers/keep-alive window)", async () => {
    // The exemption is BY CONSTRUCTION (the stream route never mutates the
    // socket timeout — doing so corrupts Node's server-wide slowloris sweep, so
    // the JSON routes' CAU-75 constants stay intact; that constant-intactness is
    // asserted deterministically in the backbone-server unit suite, following
    // the CAU-75 author's "no flaky live slow-client probe" decision).
    //
    // Here we prove the OTHER half over the wire: a held-open stream survives
    // well past HEADERS_TIMEOUT_MS (10s) / KEEP_ALIVE_TIMEOUT_MS (5s) and keeps
    // delivering — i.e. it is genuinely exempt, not reaped as a slowloris.
    const sse = await openSse(server.url, `/channels/${CHANNEL}/stream`);
    try {
      expect(sse.status).toBe(200);
      await new Promise<void>((r) => setTimeout(r, 12_000)); // > 10s headers TO
      const before = sse.frames().length;
      await client.append(CHANNEL, {
        type: "note",
        agent_id: "alice-agent",
        owner: "alice",
        msg_id: newMsgId(),
        body: "still streaming after the JSON timeout window",
      });
      await waitFor(() => sse.frames().length > before);
    } finally {
      sse.abort();
    }
  }, 30_000);
});
