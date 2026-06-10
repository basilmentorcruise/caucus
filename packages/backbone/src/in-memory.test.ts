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
  ChannelFullError,
  ChannelLimitError,
  DEFAULT_MAX_CHANNELS,
  DEFAULT_MAX_MESSAGES_PER_CHANNEL,
  DEFAULT_MAX_READ_LIMIT,
  DuplicatePostError,
  InMemoryBackbone,
  InvalidChannelNameError,
  InvalidCursorError,
  InvalidMessageError,
  MAX_BODY_CHARS,
  MAX_FIELD_CHARS,
  RateLimitedError,
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

  it("collides on NFC- vs NFD-spelled targets (Unicode-normalized key)", async () => {
    // Precomposed "café" (caf + U+00E9) vs decomposed "cafe" + U+0301.
    const nfc = "caf\u00e9"; // precomposed
    const nfd = "cafe\u0301"; // decomposed: e + combining acute
    expect(nfc).not.toBe(nfd); // distinct code-point sequences
    const first = await b.claim(CH, claim("a1", nfc));
    const second = await b.claim(CH, claim("a2", nfd));
    expect(first.outcome).toBe("granted");
    expect(second.outcome).toBe("already_claimed");
    if (second.outcome === "already_claimed" && first.outcome === "granted") {
      expect(second.by.msg_id).toBe(first.message.msg_id);
    }
    expect((await b.describeChannel(CH)).head).toBe(1);
  });

  it("does NOT collide across a zero-width character (accepted v0 behavior)", async () => {
    const plain = "payments";
    const withZwsp = "pay\u200bments";
    const first = await b.claim(CH, claim("a1", plain));
    const second = await b.claim(CH, claim("a2", withZwsp));
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
    // 50 posts from one agent would trip the default rate cap (30); this test is
    // about the monotonic stamp, not seatbelts, so use a backbone with a high cap.
    const bb = new InMemoryBackbone({ maxPostsPerMinute: 1000 });
    await bb.createChannel({ channel: CH, purpose: "investigation", created_by: "alice" });
    const stamps: string[] = [];
    for (let i = 0; i < 50; i++) {
      const r = await bb.append(CH, finding("a1", `m${i}`));
      stamps.push(r.message.ts);
    }
    const sorted = [...stamps].sort();
    expect(stamps).toEqual(sorted);
    expect(new Set(stamps).size).toBe(stamps.length);
  });
});

describe("log immutability (returned references are frozen)", () => {
  it("a returned AppendResult.message is frozen and cannot mutate the log", async () => {
    const res = await b.append(CH, finding("a1", "original"));
    const msg = res.message;
    expect(Object.isFrozen(msg)).toBe(true);
    // Mutating any field throws in strict mode (test files are ESM = strict).
    expect(() => {
      (msg as { owner: string }).owner = "mallory";
    }).toThrow(TypeError);
    expect(() => {
      (msg as { body: string }).body = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      (msg as { ts: string }).ts = "0";
    }).toThrow(TypeError);
    // A subsequent read shows the stored log unchanged.
    const read = await b.readSince(CH, 0);
    expect(read.messages[0]?.owner).toBe("alice");
    expect(read.messages[0]?.body).toBe("original");
  });

  it("a message read back via readSince is frozen too", async () => {
    await b.append(CH, finding("a1", "kept"));
    const read = await b.readSince(CH, 0);
    const msg = read.messages[0]!;
    expect(Object.isFrozen(msg)).toBe(true);
    expect(() => {
      (msg as { body: string }).body = "nope";
    }).toThrow(TypeError);
    const reread = await b.readSince(CH, 0);
    expect(reread.messages[0]?.body).toBe("kept");
  });

  it("deep-freezes nested fields so to[] cannot be mutated", async () => {
    const withTo: MessageInput = {
      type: "finding",
      agent_id: "a1",
      owner: "alice",
      msg_id: newMsgId(),
      body: "addressed",
      to: ["a2"],
    };
    const res = await b.append(CH, withTo);
    const to = res.message.to as string[];
    expect(Object.isFrozen(to)).toBe(true);
    expect(() => {
      to.push("a3");
    }).toThrow(TypeError);
    expect(() => {
      to[0] = "a9";
    }).toThrow(TypeError);
    const read = await b.readSince(CH, 0);
    expect(read.messages[0]?.to).toEqual(["a2"]);
  });

  it("a granted claim message is frozen and cannot mutate the log", async () => {
    const res = await b.claim(CH, claim("alice", "db-shard-7"));
    expect(res.outcome).toBe("granted");
    if (res.outcome !== "granted") return;
    const msg = res.message;
    expect(Object.isFrozen(msg)).toBe(true);
    expect(() => {
      (msg as { owner: string }).owner = "mallory";
    }).toThrow(TypeError);
    expect(() => {
      (msg as { target: string }).target = "something-else";
    }).toThrow(TypeError);
    const read = await b.readSince(CH, 0);
    expect(read.messages[0]?.owner).toBe("alice");
    expect(read.messages[0]?.target).toBe("db-shard-7");
    expect(read.messages[0]?.type).toBe("claim");
  });
});

describe("field size caps", () => {
  it("accepts a target at the cap and rejects one over it", async () => {
    const atCap = await b.claim(CH, claim("a1", "t".repeat(MAX_FIELD_CHARS)));
    expect(atCap.outcome).toBe("granted");
    await expect(
      b.claim(CH, claim("a2", "t".repeat(MAX_FIELD_CHARS + 1))),
    ).rejects.toBeInstanceOf(InvalidMessageError);
  });

  it("accepts a purpose at the cap and rejects one over it", async () => {
    const ok = await b.createChannel({
      channel: "cap-ok",
      purpose: "p".repeat(MAX_FIELD_CHARS),
      created_by: "alice",
    });
    expect(ok.channel).toBe("cap-ok");
    await expect(
      b.createChannel({
        channel: "cap-bad",
        purpose: "p".repeat(MAX_FIELD_CHARS + 1),
        created_by: "alice",
      }),
    ).rejects.toBeInstanceOf(InvalidMessageError);
  });

  it("accepts a to[] entry at the cap and rejects one over it", async () => {
    const atCap: MessageInput = {
      type: "finding",
      agent_id: "a1",
      owner: "alice",
      msg_id: newMsgId(),
      body: "x",
      to: ["r".repeat(MAX_FIELD_CHARS)],
    };
    await expect(b.append(CH, atCap)).resolves.toMatchObject({ cursor: 1 });

    const over: MessageInput = {
      type: "finding",
      agent_id: "a1",
      owner: "alice",
      msg_id: newMsgId(),
      body: "x",
      to: ["r".repeat(MAX_FIELD_CHARS + 1)],
    };
    await expect(b.append(CH, over)).rejects.toBeInstanceOf(InvalidMessageError);
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

  it("rejects a control-byte channel name WITHOUT echoing the bytes (CAU-81)", async () => {
    // `\u009b` is the C1 CSI byte (what a URL path's %C2%9B decodes to) —
    // JSON.stringify does NOT escape it; \x7f is DEL (also unescaped).
    for (const name of ["\u009b31mevil", "del\x7fname", "esc\x1b[2Jname"]) {
      const thrown = await b.describeChannel(name).then(
        () => undefined,
        (err: unknown) => err as InvalidChannelNameError,
      );
      expect(thrown).toBeInstanceOf(InvalidChannelNameError);
      // eslint-disable-next-line no-control-regex -- intentionally matching control bytes
      expect(thrown!.message).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
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

describe("control characters rejected at write (CAU-71)", () => {
  const ESC = "\x1b"; // ANSI escape introducer

  it("rejects an append whose body carries ESC; head unchanged", async () => {
    const headBefore = (await b.describeChannel(CH)).head;
    await expect(
      b.append(CH, finding("a1", `before${ESC}[2Jafter`)),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect((await b.describeChannel(CH)).head).toBe(headBefore);
  });

  it("rejects a claim with a dirty target; ledger stays empty (clean re-claim wins)", async () => {
    await expect(
      b.claim(CH, claim("a1", `db-pool${ESC}`)),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    expect((await b.describeChannel(CH)).head).toBe(0);
    // The dirty claim never reached the ledger: a clean claim still wins.
    const clean = await b.claim(CH, claim("a2", "db-pool"));
    expect(clean.outcome).toBe("granted");
  });

  it("rejects createChannel with a dirty purpose", async () => {
    await expect(
      b.createChannel({
        channel: "dirty-purpose",
        purpose: `p${ESC}[2J`,
        created_by: "alice",
      }),
    ).rejects.toBeInstanceOf(InvalidMessageError);
    await expect(b.describeChannel("dirty-purpose")).rejects.toBeInstanceOf(
      UnknownChannelError,
    );
  });

  it("accepts a multi-line purpose (\\t/\\n are body-safe whitespace)", async () => {
    const desc = await b.createChannel({
      channel: "multi-line",
      purpose: "line 1\nline 2\tend",
      created_by: "alice",
    });
    expect(desc.purpose).toBe("line 1\nline 2\tend");
  });

  it("rejects createChannel with a dirty created_by (no whitespace exemption)", async () => {
    await expect(
      b.createChannel({
        channel: "dirty-creator",
        purpose: "p",
        created_by: "mal\nlory",
      }),
    ).rejects.toBeInstanceOf(InvalidMessageError);
  });

  it("rejects createChannel with a NON-STRING purpose; channel not created", async () => {
    // The contract types `purpose` as a string, but an untyped HTTP body can
    // carry anything — a stored non-string would make every later
    // list/describe throw in the read-side sanitizer. Enforce at the boundary.
    for (const purpose of [[`${ESC}[2J`], 42] as const) {
      await expect(
        b.createChannel({
          channel: "nonstring-purpose",
          purpose: purpose as unknown as string,
          created_by: "alice",
        }),
      ).rejects.toBeInstanceOf(InvalidMessageError);
      await expect(
        b.describeChannel("nonstring-purpose"),
      ).rejects.toBeInstanceOf(UnknownChannelError);
    }
  });

  it("still allows ABSENT purpose/created_by (undefined skips the guards)", async () => {
    // The non-string rejection must not tighten the absent case: an untyped
    // HTTP body may simply omit these fields, exactly as before.
    const desc = await b.createChannel({
      channel: "no-optional-fields",
    } as unknown as Parameters<InMemoryBackbone["createChannel"]>[0]);
    expect(desc.channel).toBe("no-optional-fields");
  });

  it("rejects createChannel with a NON-STRING created_by; channel not created", async () => {
    for (const created_by of [["alice"], 42] as const) {
      await expect(
        b.createChannel({
          channel: "nonstring-creator",
          purpose: "p",
          created_by: created_by as unknown as string,
        }),
      ).rejects.toBeInstanceOf(InvalidMessageError);
      await expect(
        b.describeChannel("nonstring-creator"),
      ).rejects.toBeInstanceOf(UnknownChannelError);
    }
  });
});

describe("seatbelts (ADR-C8) — rate limit + loop/dup at the append path", () => {
  /** Read the channel head (number of appended messages). */
  async function head(bb: InMemoryBackbone): Promise<number> {
    return (await bb.describeChannel(CH)).head;
  }

  it("rejects an over-cap append with RateLimitedError; log + head unchanged", async () => {
    const bb = new InMemoryBackbone({ maxPostsPerMinute: 2 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });

    await bb.append(CH, finding("a1", "m0"));
    await bb.append(CH, finding("a1", "m1"));
    const headBefore = await head(bb);

    await expect(bb.append(CH, finding("a1", "m2"))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect(await head(bb)).toBe(headBefore);
    const { messages } = await bb.readSince(CH, 0);
    expect(messages.map((m) => m.body)).toEqual(["m0", "m1"]);
  });

  it("the over-cap error states the cap and a wait, never the body (ADR-C12)", async () => {
    const bb = new InMemoryBackbone({ maxPostsPerMinute: 1 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });
    await bb.append(CH, finding("a1", "first"));

    let thrown: RateLimitedError | undefined;
    await bb.append(CH, finding("a1", "secret-body-content")).catch((e) => {
      thrown = e as RateLimitedError;
    });
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(thrown!.message).toContain("at most 1 posts/min");
    expect(thrown!.message).not.toContain("secret-body-content");
  });

  it("rejects a duplicate consecutive append with DuplicatePostError; log unchanged", async () => {
    const bb = new InMemoryBackbone();
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });
    await bb.append(CH, finding("a1", "same"));
    const headBefore = await head(bb);

    await expect(bb.append(CH, finding("a1", "same"))).rejects.toBeInstanceOf(
      DuplicatePostError,
    );
    expect(await head(bb)).toBe(headBefore);
  });

  it("the duplicate error never echoes the body (ADR-C12)", async () => {
    const bb = new InMemoryBackbone();
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });
    await bb.append(CH, finding("a1", "secret-loop-text"));
    let thrown: DuplicatePostError | undefined;
    await bb.append(CH, finding("a1", "secret-loop-text")).catch((e) => {
      thrown = e as DuplicatePostError;
    });
    expect(thrown).toBeInstanceOf(DuplicatePostError);
    expect(thrown!.message).not.toContain("secret-loop-text");
  });

  it("default opts never trip for a handful of varied posts (AC3 engine guard)", async () => {
    // Default backbone `b` (cap 30); a realistic burst of distinct posts admits.
    for (let i = 0; i < 8; i++) {
      await expect(b.append(CH, finding("a1", `update ${i}`))).resolves.toBeDefined();
    }
  });

  it("a granted claim consumes rate budget", async () => {
    const bb = new InMemoryBackbone({ maxPostsPerMinute: 1 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });

    const granted = await bb.claim(CH, claim("a1", "t1"));
    expect(granted.outcome).toBe("granted");
    // The single slot is now spent: the next claim from a1 is rate-limited.
    await expect(bb.claim(CH, claim("a1", "t2"))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it("an already_claimed (losing) claim consumes NO budget — losers don't throw rate_limited", async () => {
    const bb = new InMemoryBackbone({ maxPostsPerMinute: 1 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });

    // a2 wins the target first.
    const won = await bb.claim(CH, claim("a2", "hot"));
    expect(won.outcome).toBe("granted");

    // a1 loses the SAME target many times: each is already_claimed, none charged,
    // so a1 is never rate-limited despite a cap of 1.
    for (let i = 0; i < 5; i++) {
      const r = await bb.claim(CH, claim("a1", "hot"));
      expect(r.outcome).toBe("already_claimed");
    }
    // And because a1 spent nothing, a1 can still win a fresh target.
    const fresh = await bb.claim(CH, claim("a1", "cold"));
    expect(fresh.outcome).toBe("granted");
  });

  it("an over-cap claim rejection leaves the ledger uncorrupted", async () => {
    const bb = new InMemoryBackbone({ maxPostsPerMinute: 1 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });

    await bb.claim(CH, claim("a1", "t1")); // spends a1's only slot
    const headBefore = (await bb.describeChannel(CH)).head;

    // a1's claim on a NEW target trips the rate cap (checked pre-CAS), so nothing
    // is appended and the ledger never records t2.
    await expect(bb.claim(CH, claim("a1", "t2"))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    expect((await bb.describeChannel(CH)).head).toBe(headBefore);

    // t2 was never claimed: a different agent can still win it cleanly.
    const r = await bb.claim(CH, claim("a2", "t2"));
    expect(r.outcome).toBe("granted");
  });

  it("claims are NOT dup-blocked — a repeated claim is answered by the ledger, not DuplicatePostError", async () => {
    const bb = new InMemoryBackbone();
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });

    // Identical-bodied claims for the SAME target from the same agent: the second
    // is `already_claimed` (the ledger's dedup answer), NOT a duplicate_post throw.
    const first = await bb.claim(CH, claim("a1", "svc"));
    expect(first.outcome).toBe("granted");
    const second = await bb.claim(CH, claim("a1", "svc"));
    expect(second.outcome).toBe("already_claimed");
  });

  it("rate budget is isolated per agent (one agent's flood doesn't block another)", async () => {
    const bb = new InMemoryBackbone({ maxPostsPerMinute: 1 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });

    await bb.append(CH, finding("a1", "x"));
    await expect(bb.append(CH, finding("a1", "y"))).rejects.toBeInstanceOf(
      RateLimitedError,
    );
    // a2 is unaffected.
    await expect(bb.append(CH, finding("a2", "z"))).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// CAU-74 — resource caps at the backbone: the channel-create throttle, the
// backbone-wide channel-count cap, and the per-channel message cap (append +
// claim paths), including the load-bearing ordering (cap checks before any
// seatbelt budget is charged).
// ---------------------------------------------------------------------------

describe("channel-create throttle (CAU-74)", () => {
  /** A controllable clock for deterministic windows. */
  function fakeClock(start = 0): { now: () => number; set: (t: number) => void } {
    let t = start;
    return { now: () => t, set: (v) => { t = v; } };
  }

  it("rejects the N+1th create with rate_limited (scope create); the window slides", async () => {
    const clock = fakeClock();
    const bb = new InMemoryBackbone({
      maxChannelCreatesPerMinute: 2,
      clock: clock.now,
    });
    await bb.createChannel({ channel: "c1", purpose: "p", created_by: "alice" });
    await bb.createChannel({ channel: "c2", purpose: "p", created_by: "alice" });

    let thrown: RateLimitedError | undefined;
    await bb
      .createChannel({ channel: "c3", purpose: "p", created_by: "alice" })
      .catch((e) => {
        thrown = e as RateLimitedError;
      });
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(thrown!.code).toBe("rate_limited");
    expect(thrown!.scope).toBe("create");
    expect(thrown!.message).toContain("at most 2 channel creates/min per owner");
    // The rejected channel was never created.
    await expect(bb.describeChannel("c3")).rejects.toBeInstanceOf(UnknownChannelError);

    // A minute later the budget is free again.
    clock.set(60_001);
    await expect(
      bb.createChannel({ channel: "c3", purpose: "p", created_by: "alice" }),
    ).resolves.toMatchObject({ channel: "c3" });
  });

  it("is keyed per creator — bob is unaffected by alice's spent budget", async () => {
    const bb = new InMemoryBackbone({ maxChannelCreatesPerMinute: 1 });
    await bb.createChannel({ channel: "a1", purpose: "p", created_by: "alice" });
    await expect(
      bb.createChannel({ channel: "a2", purpose: "p", created_by: "alice" }),
    ).rejects.toBeInstanceOf(RateLimitedError);
    await expect(
      bb.createChannel({ channel: "b1", purpose: "p", created_by: "bob" }),
    ).resolves.toMatchObject({ channel: "b1" });
  });

  it("rejected creates consume NO budget (bad slug, channel_exists rerun, over-cap purpose)", async () => {
    const bb = new InMemoryBackbone({ maxChannelCreatesPerMinute: 2 });
    await bb.createChannel({ channel: "ok-1", purpose: "p", created_by: "alice" });

    // Each of these rejects BEFORE the throttle, so none is charged:
    await expect(
      bb.createChannel({ channel: "BAD NAME", purpose: "p", created_by: "alice" }),
    ).rejects.toBeInstanceOf(InvalidChannelNameError);
    // …the warm-rerun path (channel already exists) in particular:
    await expect(
      bb.createChannel({ channel: "ok-1", purpose: "p", created_by: "alice" }),
    ).rejects.toBeInstanceOf(ChannelExistsError);
    await expect(
      bb.createChannel({
        channel: "big-purpose",
        purpose: "p".repeat(MAX_FIELD_CHARS + 1),
        created_by: "alice",
      }),
    ).rejects.toBeInstanceOf(InvalidMessageError);

    // Only ONE create was charged, so a second clean create still succeeds…
    await expect(
      bb.createChannel({ channel: "ok-2", purpose: "p", created_by: "alice" }),
    ).resolves.toMatchObject({ channel: "ok-2" });
    // …and the THIRD is the one the cap (2/min) rejects.
    await expect(
      bb.createChannel({ channel: "ok-3", purpose: "p", created_by: "alice" }),
    ).rejects.toBeInstanceOf(RateLimitedError);
  });
});

describe("channel-count cap (CAU-74)", () => {
  it("exposes the documented defaults", () => {
    expect(DEFAULT_MAX_CHANNELS).toBe(1_000);
    expect(DEFAULT_MAX_MESSAGES_PER_CHANNEL).toBe(10_000);
  });

  it("rejects the create that would exceed maxChannels with ChannelLimitError", async () => {
    const bb = new InMemoryBackbone({ maxChannels: 2 });
    await bb.createChannel({ channel: "c1", purpose: "p", created_by: "alice" });
    await bb.createChannel({ channel: "c2", purpose: "p", created_by: "alice" });

    let thrown: ChannelLimitError | undefined;
    await bb
      .createChannel({ channel: "c3", purpose: "p", created_by: "alice" })
      .catch((e) => {
        thrown = e as ChannelLimitError;
      });
    expect(thrown).toBeInstanceOf(ChannelLimitError);
    expect(thrown!.code).toBe("channel_limit");
    expect(thrown!.limit).toBe(2);
    expect(thrown!.message).toContain("at most 2 channels");
    // Existing channels are untouched.
    expect((await bb.listChannels()).map((c) => c.channel).sort()).toEqual(["c1", "c2"]);
  });
});

describe("per-channel message cap (CAU-74)", () => {
  it("rejects the over-cap append with ChannelFullError; head + log unchanged; cursors intact", async () => {
    const bb = new InMemoryBackbone({ maxMessagesPerChannel: 3 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });

    // A reader takes a cursor mid-stream, before the channel fills.
    await bb.append(CH, finding("a1", "m0"));
    await bb.append(CH, finding("a1", "m1"));
    const midCursor = (await bb.readSince(CH, 0)).cursor; // 2
    await bb.append(CH, finding("a1", "m2"));

    let thrown: ChannelFullError | undefined;
    await bb.append(CH, finding("a1", "m3")).catch((e) => {
      thrown = e as ChannelFullError;
    });
    expect(thrown).toBeInstanceOf(ChannelFullError);
    expect(thrown!.code).toBe("channel_full");
    expect(thrown!.channel).toBe(CH);
    expect(thrown!.limit).toBe(3);
    // The cap, the channel name — and never the rejected content (ADR-C12).
    expect(thrown!.message).toContain("at most 3 messages");
    expect(thrown!.message).toContain(`"${CH}"`);
    expect(thrown!.message).not.toContain("m3");

    // Head unchanged; the capped log reads back exactly, from 0 and from the
    // reader's pre-cap cursor; subscribe mints at head == cap.
    expect((await bb.describeChannel(CH)).head).toBe(3);
    const full = await bb.readSince(CH, 0);
    expect(full.messages.map((m) => m.body)).toEqual(["m0", "m1", "m2"]);
    expect(full.cursor).toBe(3);
    const tail = await bb.readSince(CH, midCursor);
    expect(tail.messages.map((m) => m.body)).toEqual(["m2"]);
    expect(tail.cursor).toBe(3);
    expect(await bb.subscribe(CH)).toBe(3);
  });

  it("a claim on a NEW target against a full channel throws channel_full and never writes the ledger", async () => {
    const bb = new InMemoryBackbone({ maxMessagesPerChannel: 1 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });
    await bb.append(CH, finding("a1", "filler")); // channel is now full

    await expect(bb.claim(CH, claim("a2", "fresh-target"))).rejects.toBeInstanceOf(
      ChannelFullError,
    );
    expect((await bb.describeChannel(CH)).head).toBe(1);
    // The ledger was never written: the SAME target still yields channel_full
    // (an already_claimed answer would prove a phantom ledger entry).
    await expect(bb.claim(CH, claim("a3", "fresh-target"))).rejects.toBeInstanceOf(
      ChannelFullError,
    );
  });

  it("a claim on an ALREADY-CLAIMED target still answers already_claimed on a full channel", async () => {
    const bb = new InMemoryBackbone({ maxMessagesPerChannel: 1 });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });

    const won = await bb.claim(CH, claim("a1", "hot"));
    expect(won.outcome).toBe("granted"); // this append filled the channel

    const lost = await bb.claim(CH, claim("a2", "hot"));
    expect(lost.outcome).toBe("already_claimed");
    if (lost.outcome === "already_claimed") {
      expect(lost.by.agent_id).toBe("a1");
    }
  });

  it("a channel_full rejection consumes NO seatbelt budget", async () => {
    // Global budget of 1 is the observable: if the cap check ran AFTER the
    // seatbelt admit, the doomed post would burn a1's only global slot and the
    // follow-up append on ch-2 would throw rate_limited instead of succeeding.
    const bb = new InMemoryBackbone({
      maxMessagesPerChannel: 1,
      globalMaxPostsPerMinute: 1,
    });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });
    await bb.createChannel({ channel: "ch-2", purpose: "p", created_by: "alice" });
    await bb.append(CH, finding("a2", "filler")); // a2 fills the channel

    await expect(bb.append(CH, finding("a1", "doomed"))).rejects.toBeInstanceOf(
      ChannelFullError,
    );
    await expect(bb.append("ch-2", finding("a1", "doomed"))).resolves.toBeDefined();
  });

  it("channel_full takes precedence over rate_limited AND duplicate_post (cap precedes admit)", async () => {
    const bb = new InMemoryBackbone({
      maxPostsPerMinute: 2,
      maxMessagesPerChannel: 2,
    });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });
    await bb.append(CH, finding("a1", "first"));
    await bb.append(CH, finding("a1", "same"));

    // This post is simultaneously a dup of the previous post, over the rate
    // cap, AND on a full channel — the capacity error wins, proving the cap
    // check runs before the seatbelt (and the dup baseline is untouched).
    await expect(bb.append(CH, finding("a1", "same"))).rejects.toBeInstanceOf(
      ChannelFullError,
    );
  });
});

describe("readSince max page size (CAU-83)", () => {
  /** Small injected cap so paging trips well under the 30/min rate budget. */
  const READ_CAP = 3;

  /** A backbone with the small read cap and `count` messages appended. */
  async function backboneWith(count: number): Promise<InMemoryBackbone> {
    const bb = new InMemoryBackbone({ maxReadLimit: READ_CAP });
    await bb.createChannel({ channel: CH, purpose: "p", created_by: "alice" });
    for (let i = 0; i < count; i++) {
      await bb.append(CH, finding("a1", `m${i}`));
    }
    return bb;
  }

  it("pins the documented default", () => {
    expect(DEFAULT_MAX_READ_LIMIT).toBe(500);
  });

  it("clamps an OMITTED limit to maxReadLimit; cursor advances by the page length", async () => {
    const bb = await backboneWith(5);
    const page = await bb.readSince(CH, 0); // no limit ⇒ at most the cap
    expect(page.messages.map((m) => m.body)).toEqual(["m0", "m1", "m2"]);
    expect(page.cursor).toBe(page.messages.length); // advanced by exactly the page
  });

  it("clamps an over-cap limit SILENTLY; an under-cap limit is honored exactly", async () => {
    const bb = await backboneWith(5);
    // limit > max ⇒ clamped to the cap, no error.
    const clamped = await bb.readSince(CH, 0, 999);
    expect(clamped.messages).toHaveLength(READ_CAP);
    expect(clamped.cursor).toBe(READ_CAP);
    // limit <= max ⇒ honored exactly.
    const exact = await bb.readSince(CH, 0, 2);
    expect(exact.messages.map((m) => m.body)).toEqual(["m0", "m1"]);
    expect(exact.cursor).toBe(2);
  });

  it("drains 7 messages as pages of 3/3/1 — exact order, no dups, then an empty page at head", async () => {
    const bb = await backboneWith(7);
    const head = (await bb.describeChannel(CH)).head;

    const bodies: string[] = [];
    let cursor = 0;
    const pageSizes: number[] = [];
    for (;;) {
      const page = await bb.readSince(CH, cursor);
      if (page.messages.length === 0) {
        // Empty page ⇔ caught up: the cursor must be unchanged.
        expect(page.cursor).toBe(cursor);
        break;
      }
      pageSizes.push(page.messages.length);
      bodies.push(...page.messages.map((m) => m.body));
      cursor = page.cursor;
    }

    expect(pageSizes).toEqual([3, 3, 1]);
    expect(bodies).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6"]);
    expect(new Set(bodies).size).toBe(7); // no duplicates
    expect(cursor).toBe(head); // converged on head
  });

  it("returns a short final page when the cursor is near head", async () => {
    const bb = await backboneWith(5);
    const page = await bb.readSince(CH, 4); // 1 message left, cap is 3
    expect(page.messages.map((m) => m.body)).toEqual(["m4"]);
    expect(page.cursor).toBe(5);
  });

  it("regression: a non-positive or non-integer limit is still invalid_cursor; pages stay immutable", async () => {
    const bb = await backboneWith(2);
    await expect(bb.readSince(CH, 0, 0)).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(bb.readSince(CH, 0, -2)).rejects.toBeInstanceOf(InvalidCursorError);
    await expect(bb.readSince(CH, 0, 1.5)).rejects.toBeInstanceOf(InvalidCursorError);
    // The clamp does not change what is returned: still the frozen log records.
    const page = await bb.readSince(CH, 0);
    expect(Object.isFrozen(page.messages[0])).toBe(true);
    expect(() => {
      (page.messages[0] as { body: string }).body = "tampered";
    }).toThrow(TypeError);
  });
});
