/**
 * Behavioral tests for `InMemoryBackbone` — the executable specification of the
 * backbone contract: claim conflict (incl. the headline concurrency test),
 * cursor advancement, channel lifecycle, the monotonic `ts` stamp, and the full
 * validation / error taxonomy.
 */
import { newMsgId, type MessageInput } from "@caucus/schema";
import { beforeEach, describe, expect, it } from "vitest";

import {
  ChannelExistsError,
  InMemoryBackbone,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  MAX_BODY_CHARS,
  UnknownChannelError,
} from "./index.js";

const CH = "incident-1";

let b: InMemoryBackbone;

beforeEach(async () => {
  b = new InMemoryBackbone();
  await b.createChannel({ channel: CH, purpose: "investigation", created_by: "alice" });
});

/** A non-claim message authored by `agent`. */
function finding(agent: string, body = "note"): MessageInput {
  return {
    type: "finding",
    agent_id: agent,
    owner: "alice",
    msg_id: newMsgId(),
    body,
  };
}

/** A claim message for `target` authored by `agent`. */
function claim(agent: string, target: string): MessageInput {
  return {
    type: "claim",
    agent_id: agent,
    owner: agent === "alice" ? "alice" : "bob",
    msg_id: newMsgId(),
    body: `claiming ${target}`,
    target,
  };
}

describe("claim — first-write-wins", () => {
  it("grants a single claim and makes the claim message visible (same append)", async () => {
    const before = await b.subscribe(CH);
    const res = await b.claim(CH, claim("a1", "db-shard-3"));
    expect(res.outcome).toBe("granted");

    // The granted claim is appended in the same step — visible via readSince.
    const read = await b.readSince(CH, before);
    expect(read.messages).toHaveLength(1);
    expect(read.messages[0]?.type).toBe("claim");
    if (res.outcome === "granted") {
      expect(read.messages[0]?.msg_id).toBe(res.message.msg_id);
      expect(res.cursor).toBe(before + 1);
    }
  });

  it("returns already_claimed with the winner's identity; head unchanged", async () => {
    const first = await b.claim(CH, claim("a1", "db"));
    expect(first.outcome).toBe("granted");
    const headAfterFirst = (await b.describeChannel(CH)).head;

    const second = await b.claim(CH, claim("a2", "db"));
    expect(second.outcome).toBe("already_claimed");
    if (second.outcome === "already_claimed" && first.outcome === "granted") {
      expect(second.by.agent_id).toBe("a1");
      expect(second.by.msg_id).toBe(first.message.msg_id);
      expect(second.by.owner).toBe(first.message.owner);
      expect(second.by.ts).toBe(first.message.ts);
    }
    // No append on conflict.
    expect((await b.describeChannel(CH)).head).toBe(headAfterFirst);
  });

  it("collides on whitespace-normalized targets", async () => {
    const first = await b.claim(CH, claim("a1", "  payments  "));
    const second = await b.claim(CH, claim("a2", "payments"));
    expect(first.outcome).toBe("granted");
    expect(second.outcome).toBe("already_claimed");
  });

  it("does NOT collide on case-differing targets (no case-fold)", async () => {
    const first = await b.claim(CH, claim("a1", "Payments"));
    const second = await b.claim(CH, claim("a2", "payments"));
    expect(first.outcome).toBe("granted");
    expect(second.outcome).toBe("granted");
    expect((await b.describeChannel(CH)).head).toBe(2);
  });

  it("headline: 100 iterations x 8 concurrent claimers, shuffled — exactly 1 grant", async () => {
    const ITERATIONS = 100;
    const CLAIMERS = 8;
    const winners = new Set<string>();

    for (let i = 0; i < ITERATIONS; i++) {
      const fresh = new InMemoryBackbone();
      const channel = `iter-${i}`;
      await fresh.createChannel({ channel, purpose: "x", created_by: "alice" });
      const target = `work-${i}`;

      // Shuffle the issue order so no single agent is structurally favored.
      const agents = Array.from({ length: CLAIMERS }, (_, k) => `agent-${k}`);
      for (let j = agents.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [agents[j], agents[k]] = [agents[k]!, agents[j]!];
      }

      const results = await Promise.all(
        agents.map((agent) => fresh.claim(channel, claim(agent, target))),
      );

      const granted = results.filter((r) => r.outcome === "granted");
      const conflicts = results.filter((r) => r.outcome === "already_claimed");
      expect(granted).toHaveLength(1);
      expect(conflicts).toHaveLength(CLAIMERS - 1);

      const winnerMsg =
        granted[0]?.outcome === "granted" ? granted[0].message : undefined;
      expect(winnerMsg).toBeDefined();
      winners.add(winnerMsg!.agent_id);

      // Every loser reports the SAME winner.
      for (const c of conflicts) {
        if (c.outcome === "already_claimed") {
          expect(c.by.agent_id).toBe(winnerMsg!.agent_id);
          expect(c.by.msg_id).toBe(winnerMsg!.msg_id);
        }
      }

      // Exactly one append on the channel (the granted claim).
      expect((await fresh.describeChannel(channel)).head).toBe(1);
    }

    // Winners are spread across agents, not always agent-0.
    expect(winners.size).toBeGreaterThan(1);
  });
});

describe("cursors", () => {
  it("subscribe returns the current head; pre-subscribe messages are invisible", async () => {
    await b.append(CH, finding("a1", "old"));
    const cursor = await b.subscribe(CH);
    expect(cursor).toBe(1);
    const read = await b.readSince(CH, cursor);
    expect(read.messages).toHaveLength(0);
    expect(read.cursor).toBe(1);
  });

  it("advances strictly and never duplicates across discrete reads", async () => {
    const start = await b.subscribe(CH);
    await b.append(CH, finding("a1", "m1"));
    await b.append(CH, finding("a1", "m2"));

    const first = await b.readSince(CH, start);
    expect(first.messages.map((m) => m.body)).toEqual(["m1", "m2"]);
    expect(first.cursor).toBe(start + 2);

    await b.append(CH, finding("a1", "m3"));
    const second = await b.readSince(CH, first.cursor);
    expect(second.messages.map((m) => m.body)).toEqual(["m3"]);
    expect(second.cursor).toBe(first.cursor + 1);

    // Re-reading from the same cursor yields zero duplicates.
    const reread = await b.readSince(CH, second.cursor);
    expect(reread.messages).toHaveLength(0);
    expect(reread.cursor).toBe(second.cursor);
  });

  it("respects the limit (pagination)", async () => {
    for (let i = 0; i < 5; i++) await b.append(CH, finding("a1", `m${i}`));
    const page1 = await b.readSince(CH, 0, 2);
    expect(page1.messages.map((m) => m.body)).toEqual(["m0", "m1"]);
    expect(page1.cursor).toBe(2);
    const page2 = await b.readSince(CH, page1.cursor, 2);
    expect(page2.messages.map((m) => m.body)).toEqual(["m2", "m3"]);
    const page3 = await b.readSince(CH, page2.cursor, 2);
    expect(page3.messages.map((m) => m.body)).toEqual(["m4"]);
    expect(page3.cursor).toBe(5);
  });

  it("leaves the cursor unchanged when there is nothing new", async () => {
    const head = await b.subscribe(CH);
    const read = await b.readSince(CH, head);
    expect(read.cursor).toBe(head);
    expect(read.messages).toHaveLength(0);
  });

  it("a granted claim advances head like any append", async () => {
    const before = await b.subscribe(CH);
    await b.claim(CH, claim("a1", "t"));
    expect((await b.describeChannel(CH)).head).toBe(before + 1);
  });
});

describe("channels", () => {
  it("creates, describes, and lists channels", async () => {
    await b.createChannel({ channel: "ch-2", purpose: "second", created_by: "bob" });
    const desc = await b.describeChannel("ch-2");
    expect(desc.purpose).toBe("second");
    expect(desc.created_by).toBe("bob");
    const all = await b.listChannels();
    expect(all.map((c) => c.channel).sort()).toEqual(["ch-2", CH]);
  });

  it("defaults verbosity to quiet and honors an explicit value", async () => {
    const quiet = await b.describeChannel(CH);
    expect(quiet.verbosity).toBe("quiet");
    await b.createChannel({
      channel: "loud",
      purpose: "p",
      created_by: "bob",
      verbosity: "chatty",
    });
    expect((await b.describeChannel("loud")).verbosity).toBe("chatty");
  });

  it("stamps ts strictly increasing under a tight append loop", async () => {
    const stamps: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await b.append(CH, finding("a1", `m${i}`));
      stamps.push(r.message.ts);
    }
    const sorted = [...stamps].sort();
    expect(stamps).toEqual(sorted);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});

describe("validation & errors", () => {
  it("rejects bad channel names", async () => {
    for (const name of ["", "UPPER", "has space", "bad_underscore", "a".repeat(65)]) {
      await expect(
        b.createChannel({ channel: name, purpose: "p", created_by: "x" }),
      ).rejects.toBeInstanceOf(InvalidChannelNameError);
    }
  });

  it("rejects duplicate createChannel", async () => {
    await expect(
      b.createChannel({ channel: CH, purpose: "again", created_by: "x" }),
    ).rejects.toBeInstanceOf(ChannelExistsError);
  });

  it("throws UnknownChannelError on every op against a missing channel", async () => {
    const missing = "no-such-channel";
    await expect(b.describeChannel(missing)).rejects.toBeInstanceOf(UnknownChannelError);
    await expect(b.append(missing, finding("a1"))).rejects.toBeInstanceOf(UnknownChannelError);
    await expect(b.readSince(missing, 0)).rejects.toBeInstanceOf(UnknownChannelError);
    await expect(b.claim(missing, claim("a1", "t"))).rejects.toBeInstanceOf(UnknownChannelError);
    await expect(b.subscribe(missing)).rejects.toBeInstanceOf(UnknownChannelError);
  });

  it("rejects invalid cursors", async () => {
    await b.append(CH, finding("a1"));
    await expect(b.readSince(CH, -1)).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(b.readSince(CH, 1.5)).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(b.readSince(CH, 99)).rejects.toBeInstanceOf(InvalidCursorError); // > head
    await expect(b.readSince(CH, 0, 0)).rejects.toBeInstanceOf(InvalidCursorError); // bad limit
    await expect(b.readSince(CH, 0, -2)).rejects.toBeInstanceOf(InvalidCursorError);
  });

  it("wraps malformed payloads as InvalidMessageError carrying .issues", async () => {
    const bad = { type: "finding", agent_id: "a1", owner: "alice", msg_id: "not-a-ulid", body: "" };
    await expect(
      b.append(CH, bad as unknown as MessageInput),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    try {
      await b.append(CH, bad as unknown as MessageInput);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidMessageError);
      expect((err as InvalidMessageError).issues.length).toBeGreaterThan(0);
    }
  });

  it("rejects a body over the size cap", async () => {
    const big = finding("a1", "x".repeat(MAX_BODY_CHARS + 1));
    await expect(b.append(CH, big)).rejects.toBeInstanceOf(InvalidMessageError);
  });

  it("rejects append of a claim-typed message", async () => {
    await expect(b.append(CH, claim("a1", "t"))).rejects.toBeInstanceOf(InvalidMessageError);
  });

  it("rejects claim() called with a non-claim message", async () => {
    await expect(b.claim(CH, finding("a1"))).rejects.toBeInstanceOf(InvalidMessageError);
  });

  it("rejects a claim whose target is only whitespace", async () => {
    const ws: MessageInput = {
      type: "claim",
      agent_id: "a1",
      owner: "alice",
      msg_id: newMsgId(),
      body: "x",
      target: "   ",
    };
    await expect(b.claim(CH, ws)).rejects.toBeInstanceOf(InvalidMessageError);
  });
});
