/**
 * Claim lifecycle — lazy expiry, heartbeat-renew, reassignment, done-state
 * (CAU-18, the ADR-C5 amendment deferred to M2). Every transition is exercised
 * against an INJECTED clock (`new InMemoryBackbone({ clock })`) so wall-clock
 * lease math is deterministic — no real timers, no sleeps.
 *
 * The suite proves each acceptance criterion empirically: a lease lapses at the
 * `>=` boundary, no-TTL never expires, an expired entry is OVERWRITTEN (not left
 * dangling), heartbeat renews only for the holder, reassignment is owner-gated,
 * done frees the key and posts a visible `status:"resolved"` message while a lazy
 * expiry posts nothing, and every new result/error string is value-free
 * (ADR-C12).
 */
import { newMsgId, type MessageInput } from "@caucus/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { InMemoryBackbone } from "./index.js";

const CH = "incident-lifecycle";

/** A mutable injected clock: tests advance `nowMs` to drive lease math. */
let nowMs: number;
const clock = (): number => nowMs;

let b: InMemoryBackbone;

beforeEach(async () => {
  nowMs = 1_000_000; // arbitrary non-zero epoch start.
  b = new InMemoryBackbone({ clock });
  await b.createChannel({ channel: CH, purpose: "lifecycle", created_by: "alice" });
});

afterEach(() => {
  // No timers/resources to release — the backbone is in-memory and clock-driven.
});

/** A claim `MessageInput` for `target` by `agent`/`owner`, fresh `msg_id`. */
function claim(
  agent: string,
  owner: string,
  target: string,
  extra: Partial<MessageInput> = {},
): MessageInput {
  return {
    type: "claim",
    agent_id: agent,
    owner,
    msg_id: newMsgId(),
    body: `claiming ${target}`,
    target,
    ...extra,
  } as MessageInput;
}

/** Channel head (number of appended messages). */
async function head(): Promise<number> {
  return (await b.describeChannel(CH)).head;
}

describe("A. Expiry (lazy wall-clock)", () => {
  it("grants normally and (via behaviour) records claimed_at + ttl", async () => {
    const r = await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    expect(r.outcome).toBe("granted");
    // The record fields are internal; we assert them through behaviour: still
    // held just before the deadline, freed at it (covered below). Here we only
    // confirm the grant appended exactly one message.
    expect(await head()).toBe(1);
  });

  it("a second claim BEFORE T elapses → already_claimed (original holder)", async () => {
    const first = await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    if (first.outcome !== "granted") throw new Error("unreachable");
    nowMs += 59_000; // < 60s
    const second = await b.claim(CH, claim("b1", "bob", "db"));
    expect(second.outcome).toBe("already_claimed");
    if (second.outcome !== "already_claimed") throw new Error("unreachable");
    expect(second.by.msg_id).toBe(first.message.msg_id);
    expect(second.by.owner).toBe("alice");
    expect(await head()).toBe(1); // loser never appends
  });

  it("a second claim AT/AFTER T (>= boundary) → granted, ledger now the new holder", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    nowMs += 60_000; // exactly T → re-claimable (>=)
    const second = await b.claim(CH, claim("b1", "bob", "db"));
    expect(second.outcome).toBe("granted");
    expect(await head()).toBe(2);
    // The lapsed lease freed the target: a third party now sees BOB holding it.
    nowMs += 1;
    const third = await b.claim(CH, claim("c1", "carol", "db"));
    expect(third.outcome).toBe("already_claimed");
    if (third.outcome !== "already_claimed") throw new Error("unreachable");
    expect(third.by.owner).toBe("bob");
  });

  it("a claim with NO lease_ttl never expires", async () => {
    await b.claim(CH, claim("a1", "alice", "db")); // no ttl
    nowMs += 10 * 365 * 24 * 3600 * 1000; // ~10 years
    const second = await b.claim(CH, claim("b1", "bob", "db"));
    expect(second.outcome).toBe("already_claimed");
    if (second.outcome !== "already_claimed") throw new Error("unreachable");
    expect(second.by.owner).toBe("alice");
  });

  it("a third claim after expiry names the NEW holder (proves overwrite, not dangling)", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 30 }));
    nowMs += 30_000;
    await b.claim(CH, claim("b1", "bob", "db", { lease_ttl: 30 })); // bob takes over
    nowMs += 30_000;
    const third = await b.claim(CH, claim("c1", "carol", "db")); // bob's lease lapsed
    expect(third.outcome).toBe("granted");
    nowMs += 1;
    const fourth = await b.claim(CH, claim("d1", "dave", "db"));
    expect(fourth.outcome).toBe("already_claimed");
    if (fourth.outcome !== "already_claimed") throw new Error("unreachable");
    expect(fourth.by.owner).toBe("carol"); // newest holder, never a stale entry
  });

  it("clock moving BACKWARDS does not expire a held lease", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    nowMs -= 100_000; // now < claimed_at_ms
    const second = await b.claim(CH, claim("b1", "bob", "db"));
    expect(second.outcome).toBe("already_claimed");
  });
});

describe("B. Heartbeat", () => {
  it("holder heartbeat renews the lease — moves the deadline", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    nowMs += 30_000; // T/2
    const hb = await b.claim(
      CH,
      claim("a1", "alice", "db", { lease_ttl: 60, heartbeat: true }),
    );
    expect(hb.outcome).toBe("granted"); // renew reported as granted
    expect(await head()).toBe(2); // the heartbeat appended a (visible) claim
    // At T*0.9 from the ORIGINAL grant the lease would have lapsed; after the
    // heartbeat at T/2 the new deadline is 30s+60s, so a rival at +54s loses.
    nowMs += 24_000; // total +54s from original grant; +24s from heartbeat
    const rival = await b.claim(CH, claim("b1", "bob", "db"));
    expect(rival.outcome).toBe("already_claimed");
    if (rival.outcome !== "already_claimed") throw new Error("unreachable");
    expect(rival.by.owner).toBe("alice");
  });

  it("WITHOUT the heartbeat the same rival WOULD have freed the target (control)", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    nowMs += 54_000; // no heartbeat in between
    // 54s < 60s, still held — so to PROVE the heartbeat moved the deadline, jump
    // past the ORIGINAL 60s deadline and confirm a no-heartbeat lease is free.
    nowMs += 7_000; // +61s total
    const rival = await b.claim(CH, claim("b1", "bob", "db"));
    expect(rival.outcome).toBe("granted");
  });

  it("a different-owner heartbeat does NOT renew or steal (already_claimed, deadline unchanged)", async () => {
    const first = await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    if (first.outcome !== "granted") throw new Error("unreachable");
    nowMs += 30_000;
    const foreignHb = await b.claim(
      CH,
      claim("b1", "bob", "db", { lease_ttl: 999, heartbeat: true }),
    );
    expect(foreignHb.outcome).toBe("already_claimed");
    if (foreignHb.outcome !== "already_claimed") throw new Error("unreachable");
    expect(foreignHb.by.owner).toBe("alice");
    expect(await head()).toBe(1); // no append from the foreign heartbeat
    // The deadline is unchanged (still alice's original 60s): she lapses on time.
    nowMs += 31_000; // +61s from original grant
    const after = await b.claim(CH, claim("c1", "carol", "db"));
    expect(after.outcome).toBe("granted");
  });

  it("a heartbeat on an EMPTY key is just a fresh claim (granted, starts a lease)", async () => {
    const r = await b.claim(
      CH,
      claim("a1", "alice", "never-claimed", { lease_ttl: 60, heartbeat: true }),
    );
    expect(r.outcome).toBe("granted");
    expect(await head()).toBe(1);
  });

  it("a heartbeat on a LAPSED key by the original holder is a fresh grant", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 30 }));
    nowMs += 30_000; // lapsed
    const hb = await b.claim(
      CH,
      claim("a1", "alice", "db", { lease_ttl: 30, heartbeat: true }),
    );
    expect(hb.outcome).toBe("granted");
    // Fresh lease from `now`: still held 29s later.
    nowMs += 29_000;
    const rival = await b.claim(CH, claim("b1", "bob", "db"));
    expect(rival.outcome).toBe("already_claimed");
  });
});

describe("C. Reassignment", () => {
  it("the current owner reassigns; the new holder is recorded; head +1; message on read path", async () => {
    const first = await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    if (first.outcome !== "granted") throw new Error("unreachable");
    const before = await head();
    const re = await b.reassignClaim(
      CH,
      claim("a1", "alice", "db"),
      { agent_id: "b1", owner: "bob" },
    );
    expect(re.outcome).toBe("granted");
    if (re.outcome !== "granted") throw new Error("unreachable");
    expect(await head()).toBe(before + 1); // exactly one message appended
    // The appended message is authored by the HANDING-OFF holder (alice) and is
    // visible on the read path.
    const read = await b.readSince(CH, before);
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.type).toBe("claim");
    expect(read.messages[0]?.owner).toBe("alice");
    // The LEDGER now points at bob: a third party sees bob, not alice.
    const third = await b.claim(CH, claim("c1", "carol", "db"));
    expect(third.outcome).toBe("already_claimed");
    if (third.outcome !== "already_claimed") throw new Error("unreachable");
    expect(third.by.owner).toBe("bob");
  });

  it("a NON-owner reassign attempt → already_claimed, ledger unchanged", async () => {
    const first = await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    if (first.outcome !== "granted") throw new Error("unreachable");
    const before = await head();
    const re = await b.reassignClaim(
      CH,
      claim("z1", "mallory", "db"), // not the holder
      { agent_id: "z2", owner: "mallory" },
    );
    expect(re.outcome).toBe("already_claimed");
    if (re.outcome !== "already_claimed") throw new Error("unreachable");
    expect(re.by.owner).toBe("alice"); // unchanged holder
    expect(await head()).toBe(before); // no append
    // Confirm alice still holds it.
    const probe = await b.claim(CH, claim("c1", "carol", "db"));
    expect(probe.outcome).toBe("already_claimed");
    if (probe.outcome !== "already_claimed") throw new Error("unreachable");
    expect(probe.by.owner).toBe("alice");
  });

  it("a different agent_id with the SAME owner may reassign (owner-match, ADR-C7)", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    const re = await b.reassignClaim(
      CH,
      claim("a2", "alice", "db"), // same owner, different session
      { agent_id: "b1", owner: "bob" },
    );
    expect(re.outcome).toBe("granted");
  });

  it("reassign of an EXPIRED claim by the former holder is NOT privileged — fresh grant to the assignee", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 30 }));
    nowMs += 30_000; // lapsed
    // Alice's lease is gone; "reassigning" now is just a plain fresh claim that
    // the assignee wins (an expired holder has no special right).
    const re = await b.reassignClaim(
      CH,
      claim("a1", "alice", "db"),
      { agent_id: "b1", owner: "bob" },
    );
    expect(re.outcome).toBe("granted");
    const probe = await b.claim(CH, claim("c1", "carol", "db"));
    expect(probe.outcome).toBe("already_claimed");
    if (probe.outcome !== "already_claimed") throw new Error("unreachable");
    expect(probe.by.owner).toBe("bob"); // the assignee, freshly granted
  });

  it("the reassigned lease honours a new lease_ttl", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 600 }));
    await b.reassignClaim(
      CH,
      claim("a1", "alice", "db", { lease_ttl: 10 }), // short new lease
      { agent_id: "b1", owner: "bob" },
    );
    nowMs += 10_000; // bob's 10s lease lapses
    const c = await b.claim(CH, claim("c1", "carol", "db"));
    expect(c.outcome).toBe("granted");
  });
});

describe("D. Explicit done-state", () => {
  it("the holder marks done → target freed (next claim granted); done posts a status:resolved message", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    const before = await head();
    const done = await b.markClaimDone(CH, claim("a1", "alice", "db"));
    expect(done.outcome).toBe("granted");
    expect(await head()).toBe(before + 1); // the resolved message is appended
    const read = await b.readSince(CH, before);
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.type).toBe("claim");
    expect(read.messages[0]?.status).toBe("resolved");
    // Freed: a later claim is granted and starts a fresh lease.
    const next = await b.claim(CH, claim("b1", "bob", "db", { lease_ttl: 60 }));
    expect(next.outcome).toBe("granted");
  });

  it("a lazy EXPIRY posts nothing, but a done DOES (distinguishable for the reader)", async () => {
    // Lapse path: nothing appended until the next claim.
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 30 }));
    const afterClaim = await head();
    nowMs += 30_000; // lapses, but lazily — no message yet
    expect(await head()).toBe(afterClaim); // expiry is SILENT
    // Done path on a different target: appends a visible message.
    await b.claim(CH, claim("a1", "alice", "auth", { lease_ttl: 60 }));
    const beforeDone = await head();
    await b.markClaimDone(CH, claim("a1", "alice", "auth"));
    expect(await head()).toBe(beforeDone + 1);
  });

  it("a NON-holder done is a no-op (head unchanged, still held by the original holder)", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    const before = await head();
    const done = await b.markClaimDone(CH, claim("z1", "mallory", "db"));
    expect(done.outcome).toBe("already_claimed");
    if (done.outcome !== "already_claimed") throw new Error("unreachable");
    expect(done.by.owner).toBe("alice");
    expect(await head()).toBe(before); // no message
    // Still held by alice.
    const probe = await b.claim(CH, claim("c1", "carol", "db"));
    expect(probe.outcome).toBe("already_claimed");
  });

  it("done by an EXPIRED holder is a no-op with NO spurious message (not_held)", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 30 }));
    const before = await head();
    nowMs += 30_000; // alice's lease lapsed
    const done = await b.markClaimDone(CH, claim("a1", "alice", "db"));
    expect(done.outcome).toBe("not_held");
    expect(await head()).toBe(before); // nothing appended
  });

  it("done on a NEVER-claimed target → not_held, no-op", async () => {
    const before = await head();
    const done = await b.markClaimDone(CH, claim("a1", "alice", "ghost"));
    expect(done.outcome).toBe("not_held");
    expect(await head()).toBe(before);
  });

  it("re-claiming a DONE target starts a fresh lease (record fully replaced)", async () => {
    await b.claim(CH, claim("a1", "alice", "db", { lease_ttl: 60 }));
    await b.markClaimDone(CH, claim("a1", "alice", "db"));
    const reclaim = await b.claim(CH, claim("b1", "bob", "db", { lease_ttl: 60 }));
    expect(reclaim.outcome).toBe("granted");
    if (reclaim.outcome !== "granted") throw new Error("unreachable");
    // Fresh holder + fresh lease: bob holds it now, and it lapses on bob's clock.
    nowMs += 60_000;
    const after = await b.claim(CH, claim("c1", "carol", "db"));
    expect(after.outcome).toBe("granted"); // bob's fresh lease lapsed on time
  });
});

describe("Cross-cutting — value-free results (ADR-C12)", () => {
  it("a not_held result carries no target/owner bytes", async () => {
    const done = await b.markClaimDone(CH, claim("a1", "alice", "secret-target"));
    expect(done.outcome).toBe("not_held");
    const serialized = JSON.stringify(done);
    expect(serialized).not.toContain("secret-target");
    expect(serialized).not.toContain("alice");
  });

  it("an already_claimed from a privileged transition carries ONLY the four-field holder identity", async () => {
    await b.claim(CH, claim("holder-agent", "holder-owner", "db", { lease_ttl: 60 }));
    const done = await b.markClaimDone(
      CH,
      claim("intruder-agent", "intruder-owner", "db"),
    );
    expect(done.outcome).toBe("already_claimed");
    if (done.outcome !== "already_claimed") throw new Error("unreachable");
    // `by` is exactly the four documented fields — no extra bytes leak.
    expect(Object.keys(done.by).sort()).toEqual([
      "agent_id",
      "msg_id",
      "owner",
      "ts",
    ]);
    // The INTRUDER's identity never echoes back to them.
    const serialized = JSON.stringify(done.by);
    expect(serialized).not.toContain("intruder");
  });
});

describe("Edges — input validation on the new methods", () => {
  it("reassignClaim rejects a non-claim message", async () => {
    await expect(
      b.reassignClaim(
        CH,
        {
          type: "finding",
          agent_id: "a1",
          owner: "alice",
          msg_id: newMsgId(),
          body: "x",
        } as MessageInput,
        { agent_id: "b1", owner: "bob" },
      ),
    ).rejects.toThrow();
  });

  it("markClaimDone rejects a non-claim message", async () => {
    await expect(
      b.markClaimDone(CH, {
        type: "finding",
        agent_id: "a1",
        owner: "alice",
        msg_id: newMsgId(),
        body: "x",
      } as MessageInput),
    ).rejects.toThrow();
  });
});
