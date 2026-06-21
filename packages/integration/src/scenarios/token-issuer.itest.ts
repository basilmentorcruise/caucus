/**
 * Integration scenario — the runtime token issuer over a REAL backbone process
 * (CAU-20). Spawns the actual `caucus-backbone` bin with `CAUCUS_TOKENS` (the
 * seed) and `CAUCUS_ADMIN_TOKEN` (the control-surface credential), then drives
 * the issuer control routes + the write routes with bare `fetch` over the wire.
 *
 * Covers, end-to-end over a real socket:
 *  - mint → use → revoke → rejected, with the ANCHORED identity asserted in the
 *    read-back (a minted token authorizes a write anchored to its identity, and
 *    after revoke the same bearer 401s — no restart).
 *  - fail-closed over the wire: a server with NO tokens and NO admin credential
 *    rejects BOTH an append (no write token) and a mint (admin disabled) with
 *    401.
 *  - two-session anchoring: mint alice + bob, neither can spoof the other in the
 *    log even when the body claims the other identity.
 */
import { newMsgId } from "@caucus/schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServerProcess } from "../harness.js";

/** Seed tokens the server boots with (the static, non-revocable layer). */
const SEED_TOKENS = "seed-alice:alice-agent:alice,seed-bob:bob-agent:bob";
/** The admin credential gating the issuer control surface. */
const ADMIN_TOKEN = "integration-admin-secret";
const CH = "incident-issuer";

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

describe("token issuer (CAU-20) — over a real backbone process", () => {
  let url: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const started = await startServerProcess({
      CAUCUS_TOKENS: SEED_TOKENS,
      CAUCUS_ADMIN_TOKEN: ADMIN_TOKEN,
    });
    url = started.url;
    stop = started.stop;
    // Create the channel with a seeded bearer (createChannel is itself gated).
    const [status] = await postJson(`${url}/channels`, "seed-alice", {
      channel: CH,
      purpose: "issuer integration",
      created_by: "anything",
    });
    expect(status).toBe(201);
  });

  afterAll(async () => {
    await stop();
  });

  it("mint → use → revoke → rejected, anchored identity in the read-back", async () => {
    // Mint a token for { x, xavier } using the admin credential.
    const [mintStatus, mintBody] = await postJson(`${url}/admin/tokens`, ADMIN_TOKEN, {
      agent_id: "x",
      owner: "xavier",
    });
    expect(mintStatus).toBe(201);
    const token = mintBody.token as string;
    expect(typeof token).toBe("string");
    expect(mintBody.agent_id).toBe("x");
    expect(mintBody.owner).toBe("xavier");

    // Use it to append, spoofing the identity in the body.
    const [appendStatus] = await postJson(`${url}/channels/${CH}/append`, token, {
      type: "finding",
      agent_id: "forged-agent",
      owner: "forged-owner",
      msg_id: newMsgId(),
      body: "minted-post",
    });
    expect(appendStatus).toBe(201);

    // Read back: the stored identity is anchored to the MINTED identity.
    const [, log] = await postJson(`${url}/channels/${CH}/read`, undefined, { cursor: 0 });
    const messages = log.messages as { owner: string; agent_id: string; body: string }[];
    const posted = messages.find((m) => m.body === "minted-post");
    expect(posted?.owner).toBe("xavier");
    expect(posted?.agent_id).toBe("x");

    // Revoke, then the SAME bearer is rejected — no restart.
    const [revStatus, revBody] = await postJson(`${url}/admin/tokens/revoke`, ADMIN_TOKEN, {
      agent_id: "x",
    });
    expect(revStatus).toBe(200);
    expect(revBody).toEqual({ revoked: true });

    const [afterStatus] = await postJson(`${url}/channels/${CH}/append`, token, {
      type: "finding",
      agent_id: "x",
      owner: "xavier",
      msg_id: newMsgId(),
      body: "after-revoke",
    });
    expect(afterStatus).toBe(401);
  });

  it("revoke by agent_id kills BOTH tokens minted for one agent_id (CAU-122)", async () => {
    // Mint the SAME agent_id twice → two live bearers over the wire.
    const [, first] = await postJson(`${url}/admin/tokens`, ADMIN_TOKEN, { agent_id: "twin", owner: "tina" });
    const [, second] = await postJson(`${url}/admin/tokens`, ADMIN_TOKEN, { agent_id: "twin", owner: "tina" });
    const firstTok = first.token as string;
    const secondTok = second.token as string;
    expect(firstTok).not.toBe(secondTok);

    // Both authorize an append before revoke.
    const [a1] = await postJson(`${url}/channels/${CH}/append`, firstTok, {
      type: "finding", agent_id: "twin", owner: "tina", msg_id: newMsgId(), body: "twin-1",
    });
    const [a2] = await postJson(`${url}/channels/${CH}/append`, secondTok, {
      type: "finding", agent_id: "twin", owner: "tina", msg_id: newMsgId(), body: "twin-2",
    });
    expect(a1).toBe(201);
    expect(a2).toBe(201);

    // ONE revoke-by-agent_id kills BOTH.
    const [revStatus, revBody] = await postJson(`${url}/admin/tokens/revoke`, ADMIN_TOKEN, { agent_id: "twin" });
    expect(revStatus).toBe(200);
    expect(revBody).toEqual({ revoked: true });

    const [after1] = await postJson(`${url}/channels/${CH}/append`, firstTok, {
      type: "finding", agent_id: "twin", owner: "tina", msg_id: newMsgId(), body: "after-1",
    });
    const [after2] = await postJson(`${url}/channels/${CH}/append`, secondTok, {
      type: "finding", agent_id: "twin", owner: "tina", msg_id: newMsgId(), body: "after-2",
    });
    expect(after1).toBe(401);
    expect(after2).toBe(401);
  });

  it("two-session anchoring: minted alice + bob cannot spoof each other", async () => {
    const [, aBody] = await postJson(`${url}/admin/tokens`, ADMIN_TOKEN, {
      agent_id: "two-alice",
      owner: "alice2",
    });
    const [, bBody] = await postJson(`${url}/admin/tokens`, ADMIN_TOKEN, {
      agent_id: "two-bob",
      owner: "bob2",
    });
    const aTok = aBody.token as string;
    const bTok = bBody.token as string;

    // Each posts while spoofing the OTHER in the body.
    await postJson(`${url}/channels/${CH}/append`, aTok, {
      type: "finding", agent_id: "two-bob", owner: "bob2", msg_id: newMsgId(), body: "alice-says",
    });
    await postJson(`${url}/channels/${CH}/append`, bTok, {
      type: "finding", agent_id: "two-alice", owner: "alice2", msg_id: newMsgId(), body: "bob-says",
    });

    const [, log] = await postJson(`${url}/channels/${CH}/read`, undefined, { cursor: 0 });
    const messages = log.messages as { owner: string; agent_id: string; body: string }[];
    const byBody = new Map(messages.map((m) => [m.body, m]));
    expect(byBody.get("alice-says")?.owner).toBe("alice2");
    expect(byBody.get("alice-says")?.agent_id).toBe("two-alice");
    expect(byBody.get("bob-says")?.owner).toBe("bob2");
    expect(byBody.get("bob-says")?.agent_id).toBe("two-bob");
  });
});

describe("token issuer (CAU-20) — fail-closed over the wire (no tokens, no admin)", () => {
  let url: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    // No CAUCUS_TOKENS, no CAUCUS_ADMIN_TOKEN.
    const started = await startServerProcess({});
    url = started.url;
    stop = started.stop;
  });

  afterAll(async () => {
    await stop();
  });

  it("an append (no write token) and a mint (admin disabled) are BOTH 401", async () => {
    // Append with no token → 401 (no seed authorizes anyone).
    const [appendStatus] = await postJson(`${url}/channels/anywhere/append`, undefined, {
      type: "finding", agent_id: "x", owner: "x", msg_id: newMsgId(), body: "nope",
    });
    expect(appendStatus).toBe(401);

    // Mint with no admin credential → 401 (control surface disabled). Even
    // presenting an arbitrary bearer cannot enable it.
    const [mintStatus] = await postJson(`${url}/admin/tokens`, "anything-at-all", {
      agent_id: "x", owner: "x",
    });
    expect(mintStatus).toBe(401);
  });
});
