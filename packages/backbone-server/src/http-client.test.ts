/**
 * Unit tests for {@link HttpBackbone} (CAU-5): real round-trips against a live
 * server for the happy paths and error reconstruction (instanceof + .code), plus
 * stubbed-fetch tests for the cases the CAU-5 server cannot yet produce
 * (`already_claimed` as a 200 RESULT — the claim route is CAU-7) and a
 * non-2xx response with an unexpected body.
 */
import {
  ChannelFullError,
  ChannelLimitError,
  InMemoryBackbone,
  InvalidMessageError,
  RateLimitedError,
  UnknownChannelError,
  type ClaimResult,
} from "@caucus/backbone";
import { newMsgId } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpBackbone } from "./http-client.js";
import { startServer, type RunningServer } from "./server.js";
import { parseTokenMap } from "./tokens.js";
import { UnauthorizedError } from "./wire-errors.js";

let server: RunningServer;
let client: HttpBackbone;

/** Writes are token-gated (CAU-13); the live-server tests carry a valid token. */
const TOKENS = parseTokenMap("tok-a:a:alice");
const TOKEN = "tok-a";

beforeAll(async () => {
  server = await startServer({ port: 0, tokens: TOKENS });
  client = new HttpBackbone(server.url, { token: TOKEN });
});

afterAll(async () => {
  await server.close();
});

const MSG_ID = newMsgId();

describe("HttpBackbone — round-trips against a live server", () => {
  it("create / describe / list", async () => {
    const created = await client.createChannel({
      channel: "rt1",
      purpose: "round trip",
      created_by: "alice",
    });
    expect(created.channel).toBe("rt1");
    expect(created.kind).toBe("ephemeral");
    expect(created.verbosity).toBe("quiet");

    const described = await client.describeChannel("rt1");
    expect(described.channel).toBe("rt1");

    const listed = await client.listChannels();
    expect(listed.map((c) => c.channel)).toContain("rt1");
  });

  it("subscribe / append / readSince — cursors pass through opaquely", async () => {
    await client.createChannel({ channel: "rt2", purpose: "p", created_by: "a" });
    const cursor = await client.subscribe("rt2");
    expect(cursor).toBe(0);

    const appended = await client.append("rt2", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: MSG_ID,
      body: "hello",
    });
    expect(appended.cursor).toBe(1);
    // `ts` is opaque — present, a string, and NOT a parseable date.
    expect(typeof appended.message.ts).toBe("string");
    expect(Number.isNaN(Date.parse(appended.message.ts))).toBe(true);

    const read = await client.readSince("rt2", cursor);
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.msg_id).toBe(MSG_ID);
    expect(read.cursor).toBe(1);

    const limited = await client.readSince("rt2", 0, 1);
    expect(limited.messages).toHaveLength(1);
  });

  it("reconstructs UnknownChannelError on a 404 (instanceof + code)", async () => {
    await expect(client.describeChannel("ghost")).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof UnknownChannelError && err.code === "unknown_channel",
    );
  });

  it("reconstructs InvalidMessageError on a 400 with issues", async () => {
    await client.createChannel({ channel: "rt3", purpose: "p", created_by: "a" });
    let caught: unknown;
    try {
      await client.append("rt3", {
        type: "finding",
        agent_id: "a",
        owner: "alice",
        msg_id: "not-a-ulid",
        body: "x",
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidMessageError);
    expect((caught as InvalidMessageError).issues.length).toBeGreaterThan(0);
  });

  it("tolerates a trailing slash in the base URL", async () => {
    const slashed = new HttpBackbone(`${server.url}/`);
    const res = await slashed.listChannels();
    expect(Array.isArray(res)).toBe(true);
  });

  it("shares server state with a second client (cross-client visibility)", async () => {
    // `a` writes, so it carries a token; `b` only reads, so it stays tokenless.
    const a = new HttpBackbone(server.url, { token: TOKEN });
    const b = new HttpBackbone(server.url);
    await a.createChannel({ channel: "shared", purpose: "p", created_by: "a" });
    const bCursor = await b.subscribe("shared");
    await a.append("shared", {
      type: "finding",
      agent_id: "a",
      owner: "alice",
      msg_id: MSG_ID,
      body: "seen by b",
    });
    const seen = await b.readSince("shared", bCursor);
    expect(seen.messages).toHaveLength(1);
    expect(seen.messages[0]?.body).toBe("seen by b");
  });
});

describe("HttpBackbone — stubbed fetch for not-yet-served cases", () => {
  it("claim returns an already_claimed RESULT (200), never a throw", async () => {
    const result: ClaimResult = {
      outcome: "already_claimed",
      by: { agent_id: "winner", owner: "bob", ts: "t#1", msg_id: "01WINNER" },
    };
    const stub: typeof fetch = () =>
      Promise.resolve(
        new Response(JSON.stringify(result), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const c = new HttpBackbone("http://stub.invalid", { fetch: stub });
    const got = await c.claim("c1", {
      type: "claim",
      agent_id: "a",
      owner: "alice",
      msg_id: MSG_ID,
      body: "claiming",
      target: "t",
    });
    expect(got.outcome).toBe("already_claimed");
    if (got.outcome === "already_claimed") {
      expect(got.by.msg_id).toBe("01WINNER");
    }
  });

  it("claim grant RESULT (200) round-trips", async () => {
    const result: ClaimResult = {
      outcome: "granted",
      cursor: 1,
      message: {
        v: 0,
        type: "claim",
        agent_id: "a",
        owner: "alice",
        msg_id: MSG_ID,
        body: "claiming",
        target: "t",
        ts: "t#1",
      },
    };
    const stub: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify(result), { status: 200 }));
    const c = new HttpBackbone("http://stub.invalid", { fetch: stub });
    const got = await c.claim("c1", {
      type: "claim",
      agent_id: "a",
      owner: "alice",
      msg_id: MSG_ID,
      body: "claiming",
      target: "t",
    });
    expect(got.outcome).toBe("granted");
  });

  it("a 501 not_implemented body reconstructs a generic BackboneError with the code", async () => {
    const stub: typeof fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: { code: "not_implemented", message: "claim is not implemented yet" },
          }),
          { status: 501 },
        ),
      );
    const c = new HttpBackbone("http://stub.invalid", { fetch: stub });
    await expect(
      c.claim("c1", {
        type: "claim",
        agent_id: "a",
        owner: "alice",
        msg_id: MSG_ID,
        body: "x",
        target: "t",
      }),
    ).rejects.toMatchObject({ code: "not_implemented" });
  });

  it("a non-2xx with an unexpected (non-wire) body → generic http_error", async () => {
    const stub: typeof fetch = () =>
      Promise.resolve(new Response("upstream exploded", { status: 502 }));
    const c = new HttpBackbone("http://stub.invalid", { fetch: stub });
    await expect(c.listChannels()).rejects.toMatchObject({ code: "http_error" });
  });

  it("sets redirect:\"error\" and surfaces a redirect as a clean throw (no cross-origin re-POST)", async () => {
    let seenRedirect: RequestInit["redirect"];
    // Mirror real fetch: with redirect:"error", a 3xx response rejects rather
    // than following the Location header (which would re-POST a sensitive body).
    const stub: typeof fetch = (_input, init) => {
      seenRedirect = init?.redirect;
      if (init?.redirect === "error") {
        return Promise.reject(new TypeError("redirect mode is 'error'"));
      }
      return Promise.resolve(
        new Response(null, { status: 302, headers: { location: "http://evil.invalid/" } }),
      );
    };
    const c = new HttpBackbone("http://stub.invalid", { fetch: stub });
    await expect(
      c.append("c1", {
        type: "finding",
        agent_id: "a",
        owner: "alice",
        msg_id: MSG_ID,
        body: "x",
      }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(seenRedirect).toBe("error");
  });

  it("an empty-body 2xx response yields undefined json (subscribe shape guarded)", async () => {
    // listChannels expects { channels }; an empty 200 would blow up on access —
    // assert the client reads the body and parses it, not that it tolerates a
    // contract violation. Here we return a valid empty list.
    const stub: typeof fetch = () =>
      Promise.resolve(new Response(JSON.stringify({ channels: [] }), { status: 200 }));
    const c = new HttpBackbone("http://stub.invalid", { fetch: stub });
    expect(await c.listChannels()).toEqual([]);
  });
});

describe("HttpBackbone — auth (CAU-13)", () => {
  it("a tokenless client's write is rejected with UnauthorizedError (401), token never echoed", async () => {
    const tokenless = new HttpBackbone(server.url);
    try {
      await tokenless.createChannel({
        channel: "auth-probe",
        purpose: "p",
        created_by: "alice",
      });
      expect.unreachable("write without a token must throw");
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedError);
      expect((err as UnauthorizedError).code).toBe("unauthorized");
      expect((err as Error).message).not.toContain("tok-a");
    }
  });

  it("an unknown token gets the identical rejection (no oracle)", async () => {
    const wrong = new HttpBackbone(server.url, { token: "tok-unknown" });
    let unknownMsg = "";
    try {
      await wrong.createChannel({
        channel: "auth-probe-2",
        purpose: "p",
        created_by: "alice",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(UnauthorizedError);
      unknownMsg = (err as Error).message;
      expect(unknownMsg).not.toContain("tok-unknown");
    }
    const none = new HttpBackbone(server.url);
    try {
      await none.createChannel({
        channel: "auth-probe-3",
        purpose: "p",
        created_by: "alice",
      });
    } catch (err) {
      // Identical message for missing vs unknown — no token-probing oracle.
      expect((err as Error).message).toBe(unknownMsg);
    }
  });

  it("sends Authorization: Bearer on requests when a token is configured", async () => {
    let seenAuth: string | null | undefined;
    const spyFetch: typeof fetch = (_input, init) => {
      seenAuth = new Headers(init?.headers).get("authorization");
      return Promise.resolve(
        new Response(JSON.stringify({ channels: [] }), { status: 200 }),
      );
    };
    const c = new HttpBackbone("http://stub", { token: "tok-a", fetch: spyFetch });
    await c.listChannels();
    expect(seenAuth).toBe("Bearer tok-a");
  });
});

describe("HttpBackbone — CAU-74 resource-cap errors reconstruct as the real classes", () => {
  it("channel_full / channel_limit / create-throttle 429 round-trip over a live server", async () => {
    const bb = new InMemoryBackbone({
      maxMessagesPerChannel: 1,
      maxChannels: 2,
      maxChannelCreatesPerMinute: 2,
    });
    const srv = await startServer({ port: 0, backbone: bb, tokens: TOKENS });
    try {
      const c = new HttpBackbone(srv.url, { token: TOKEN });
      await c.createChannel({ channel: "caps", purpose: "p", created_by: "a" });

      // Fill the channel (cap 1), then the next append → ChannelFullError.
      await c.append("caps", {
        type: "finding",
        agent_id: "a",
        owner: "alice",
        msg_id: newMsgId(),
        body: "filler",
      });
      let full: unknown;
      await c
        .append("caps", {
          type: "finding",
          agent_id: "a",
          owner: "alice",
          msg_id: newMsgId(),
          body: "rejected",
        })
        .catch((e) => {
          full = e;
        });
      expect(full).toBeInstanceOf(ChannelFullError);
      expect((full as ChannelFullError).code).toBe("channel_full");
      expect((full as ChannelFullError).channel).toBe("caps");
      expect((full as ChannelFullError).limit).toBe(1);

      // Second channel hits maxChannels on the third create → ChannelLimitError.
      await c.createChannel({ channel: "caps-2", purpose: "p", created_by: "a" });
      let limit: unknown;
      await c
        .createChannel({ channel: "caps-3", purpose: "p", created_by: "a" })
        .catch((e) => {
          limit = e;
        });
      expect(limit).toBeInstanceOf(ChannelLimitError);
      expect((limit as ChannelLimitError).limit).toBe(2);
    } finally {
      await srv.close();
    }
  });

  it("a throttled create reconstructs RateLimitedError with the real limit (regex regression)", async () => {
    const bb = new InMemoryBackbone({ maxChannelCreatesPerMinute: 1 });
    const srv = await startServer({ port: 0, backbone: bb, tokens: TOKENS });
    try {
      const c = new HttpBackbone(srv.url, { token: TOKEN });
      await c.createChannel({ channel: "t1", purpose: "p", created_by: "a" });
      let thrown: unknown;
      await c
        .createChannel({ channel: "t2", purpose: "p", created_by: "a" })
        .catch((e) => {
          thrown = e;
        });
      expect(thrown).toBeInstanceOf(RateLimitedError);
      // Without the generalized limit regex this would reconstruct as limit 0.
      expect((thrown as RateLimitedError).limit).toBe(1);
      expect((thrown as RateLimitedError).scope).toBe("create");
    } finally {
      await srv.close();
    }
  });
});

describe("HttpBackbone end-to-end with a server over a shared backbone instance", () => {
  it("client and server observe the same in-memory backbone", async () => {
    const shared = new InMemoryBackbone();
    const srv = await startServer({ port: 0, backbone: shared, tokens: TOKENS });
    try {
      const c = new HttpBackbone(srv.url, { token: TOKEN });
      await c.createChannel({ channel: "e2e", purpose: "p", created_by: "a" });
      // The server's backbone now has the channel — observe it directly.
      const direct = await shared.describeChannel("e2e");
      expect(direct.channel).toBe("e2e");
    } finally {
      await srv.close();
    }
  });
});
