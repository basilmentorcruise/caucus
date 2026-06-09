/**
 * Integration scenario — server-anchored identity over a REAL HTTP backbone
 * (CAU-13). Proves the three acceptance criteria end-to-end against a live
 * token-gated server:
 *
 *  - AC1: a session presents a token and gets a STABLE agent→human identity —
 *    every post it makes reads back with the token's owner, across many posts.
 *  - AC2: two sessions on the same channel have DISTINCT, CORRECT owners that
 *    are never crossed.
 *  - AC3: the claimed owner CANNOT be forged. A raw `fetch` POST carrying
 *    alice's bearer but a spoofed `owner`/`agent_id` in the body is stored as
 *    ALICE (the bearer's identity), and the spoofed value never appears in the
 *    log; no bearer → 401; an unknown bearer → 401 with the IDENTICAL body.
 *
 * AC1/AC2 run through the harness {@link httpConnector} (deterministic tokens
 * per id, anchored to `{ agent_id: "<id>-agent", owner: "<id>" }`). AC3 needs
 * the raw server URL to bypass the well-behaved client, so it stands up its own
 * {@link startServer} with an explicit token map and drives it with bare
 * `fetch`.
 */
import { InMemoryBackbone } from "@caucus/backbone";
import {
  startServer,
  tokenDigest,
  type RunningServer,
  type TokenMap,
} from "@caucus/backbone-server";
import { newMsgId } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  claimMsg,
  finding,
  httpConnector,
  identityForId,
  type ClientHandle,
  type Connector,
} from "../index.js";

const CH = "incident-identity";

describe("server-anchored identity (CAU-13) — over HTTP", () => {
  const connector: Connector = httpConnector();
  let alice: ClientHandle;
  let bob: ClientHandle;

  beforeAll(async () => {
    await connector.boot();
    alice = await connector.connectClient("alice");
    bob = await connector.connectClient("bob");
    await alice.backbone.createChannel({
      channel: CH,
      purpose: "identity anchoring",
      created_by: "alice",
    });
  });

  afterAll(async () => {
    await connector.teardown();
  });

  it("AC1: a token yields a stable owner across many posts", async () => {
    const before = (await alice.backbone.describeChannel(CH)).head;

    // Five posts from alice's session, deliberately claiming a DIFFERENT owner
    // in the body each time — the server must overwrite all of them to alice.
    for (let i = 0; i < 5; i++) {
      await alice.backbone.append(
        CH,
        finding("not-alice-agent", "not-alice", { body: `post ${i}` }),
      );
    }

    const read = await alice.backbone.readSince(CH, before);
    expect(read.messages).toHaveLength(5);
    for (const m of read.messages) {
      expect(m.owner).toBe("alice");
      expect(m.agent_id).toBe("alice-agent");
    }
  });

  it("AC2: two sessions have distinct, correct, never-crossed owners", async () => {
    const before = (await alice.backbone.describeChannel(CH)).head;

    // Interleaved posts from both sessions; each spoofs the OTHER in the body.
    await alice.backbone.append(CH, finding("x", "bob", { body: "from alice 1" }));
    await bob.backbone.append(CH, finding("y", "alice", { body: "from bob 1" }));
    await alice.backbone.append(CH, finding("x", "bob", { body: "from alice 2" }));
    await bob.backbone.append(CH, finding("y", "alice", { body: "from bob 2" }));

    const read = await alice.backbone.readSince(CH, before);
    const byBody = new Map(read.messages.map((m) => [m.body, m]));

    // Owners follow the BEARER, never the spoofed body — and are never crossed.
    expect(byBody.get("from alice 1")?.owner).toBe("alice");
    expect(byBody.get("from alice 1")?.agent_id).toBe("alice-agent");
    expect(byBody.get("from bob 1")?.owner).toBe("bob");
    expect(byBody.get("from bob 1")?.agent_id).toBe("bob-agent");
    expect(byBody.get("from alice 2")?.owner).toBe("alice");
    expect(byBody.get("from bob 2")?.owner).toBe("bob");

    // A claim race keys on the ANCHORED agent_id: distinct sessions are distinct
    // claimants even when both spoof the same agent_id in the body.
    const [aRes, bRes] = await Promise.all([
      alice.backbone.claim(CH, claimMsg("forged", "forged", "shared-target")),
      bob.backbone.claim(CH, claimMsg("forged", "forged", "shared-target")),
    ]);
    const outcomes = [aRes.outcome, bRes.outcome].sort();
    expect(outcomes).toEqual(["already_claimed", "granted"]);
    const winner = aRes.outcome === "granted" ? aRes : bRes;
    if (winner.outcome !== "granted") throw new Error("unreachable");
    // The winner is anchored to whichever session won — one of the two real
    // owners, never the forged "forged".
    expect(["alice", "bob"]).toContain(winner.message.owner);
    expect(winner.message.owner).not.toBe("forged");
  });
});

/**
 * AC3 — the forge attempt. Stand up a server with a known token map and drive it
 * with bare `fetch`, bypassing the well-behaved {@link httpConnector} client so
 * we can present arbitrary bearers and spoofed bodies.
 */
describe("server-anchored identity (CAU-13) — forge attempt via raw fetch", () => {
  const ALICE_TOKEN = "alice-secret-token";
  const FORGE_CH = "incident-forge";
  let server: RunningServer;

  /**
   * alice's bearer anchors to `{ agent_id: "alice-agent", owner: "alice" }`.
   * The map is keyed by the bearer's SHA-256 digest (CAU-75) — the server
   * never stores token plaintext.
   */
  const tokens: TokenMap = new Map([
    [tokenDigest(ALICE_TOKEN), identityForId("alice")],
  ]);

  beforeAll(async () => {
    server = await startServer({
      port: 0,
      backbone: new InMemoryBackbone(),
      tokens,
    });
    // Create the channel with alice's bearer (createChannel is itself gated).
    const res = await fetch(`${server.url}/channels`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body: JSON.stringify({ channel: FORGE_CH, purpose: "forge", created_by: "mallory" }),
    });
    expect(res.status).toBe(201);
    const desc = (await res.json()) as { created_by: string };
    // Even createChannel anchors: created_by is alice, not the spoofed mallory.
    expect(desc.created_by).toBe("alice");
  });

  afterAll(async () => {
    await server.close();
  });

  it("stores alice as the owner despite a spoofed body; 'mallory' never lands", async () => {
    // alice's REAL bearer, but the body claims to be mallory with a spoofed
    // agent_id — the classic forgery attempt.
    const res = await fetch(`${server.url}/channels/${FORGE_CH}/append`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      body: JSON.stringify({
        type: "finding",
        agent_id: "mallory-agent",
        owner: "mallory",
        msg_id: newMsgId(),
        // Body text is deliberately free of the spoofed identity string so the
        // "mallory never lands in the log" assertion checks IDENTITY, not prose.
        body: "a perfectly innocent finding",
      }),
    });
    expect(res.status).toBe(201);
    const appended = (await res.json()) as { message: { owner: string; agent_id: string } };
    // Anchored to the bearer — the forged identity was overwritten.
    expect(appended.message.owner).toBe("alice");
    expect(appended.message.agent_id).toBe("alice-agent");

    // Read the whole log back and prove "mallory" never landed anywhere.
    const readRes = await fetch(`${server.url}/channels/${FORGE_CH}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor: 0 }),
    });
    expect(readRes.status).toBe(200);
    const log = await readRes.text();
    expect(log).not.toContain("mallory");
    const parsed = JSON.parse(log) as { messages: { owner: string; agent_id: string }[] };
    for (const m of parsed.messages) {
      expect(m.owner).toBe("alice");
      expect(m.agent_id).toBe("alice-agent");
    }
  });

  it("rejects a write with NO bearer (401)", async () => {
    const res = await fetch(`${server.url}/channels/${FORGE_CH}/append`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "finding",
        agent_id: "x",
        owner: "x",
        msg_id: newMsgId(),
        body: "no token",
      }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.message).toBe("missing or invalid token");
  });

  it("rejects an UNKNOWN bearer (401) with the IDENTICAL body (no oracle)", async () => {
    // No bearer.
    const noBearer = await fetch(`${server.url}/channels/${FORGE_CH}/append`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "finding", agent_id: "x", owner: "x", msg_id: newMsgId(), body: "a" }),
    });
    // A syntactically-valid but UNKNOWN bearer.
    const unknownBearer = await fetch(`${server.url}/channels/${FORGE_CH}/append`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer not-a-real-token" },
      body: JSON.stringify({ type: "finding", agent_id: "x", owner: "x", msg_id: newMsgId(), body: "b" }),
    });

    expect(noBearer.status).toBe(401);
    expect(unknownBearer.status).toBe(401);
    // Byte-identical bodies: "missing" and "unknown" are indistinguishable.
    expect(await unknownBearer.text()).toBe(await noBearer.text());
  });
});
