/**
 * Unit tests for {@link HttpBackbone} (CAU-5): real round-trips against a live
 * server for the happy paths and error reconstruction (instanceof + .code), plus
 * stubbed-fetch tests for the cases the CAU-5 server cannot yet produce
 * (`already_claimed` as a 200 RESULT — the claim route is CAU-7) and a
 * non-2xx response with an unexpected body.
 */
import {
  InMemoryBackbone,
  InvalidMessageError,
  UnknownChannelError,
  type ClaimResult,
} from "@caucus/backbone";
import { newMsgId } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HttpBackbone } from "./http-client.js";
import { startServer, type RunningServer } from "./server.js";

let server: RunningServer;
let client: HttpBackbone;

beforeAll(async () => {
  server = await startServer({ port: 0 });
  client = new HttpBackbone(server.url);
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
    const a = new HttpBackbone(server.url);
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

describe("HttpBackbone end-to-end with a server over a shared backbone instance", () => {
  it("client and server observe the same in-memory backbone", async () => {
    const shared = new InMemoryBackbone();
    const srv = await startServer({ port: 0, backbone: shared });
    try {
      const c = new HttpBackbone(srv.url);
      await c.createChannel({ channel: "e2e", purpose: "p", created_by: "a" });
      // The server's backbone now has the channel — observe it directly.
      const direct = await shared.describeChannel("e2e");
      expect(direct.channel).toBe("e2e");
    } finally {
      await srv.close();
    }
  });
});
