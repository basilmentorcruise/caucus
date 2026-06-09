/**
 * Unit tests for the seatbelt (ADR-C8): the per-agent rate-limit sliding window
 * and the consecutive-duplicate (loop) detector. The clock is injected so window
 * behavior is deterministic with no real waits.
 */
import { describe, expect, it } from "vitest";

import { DuplicatePostError, RateLimitedError } from "./errors.js";
import {
  DEFAULT_DUP_WINDOW,
  DEFAULT_GLOBAL_RATE_MULTIPLIER,
  DEFAULT_MAX_CHANNEL_CREATES_PER_MINUTE,
  DEFAULT_MAX_POSTS_PER_MINUTE,
  DEFAULT_MAX_TRACKED_AGENTS,
  Seatbelt,
  SEATBELT_WINDOW_MS,
  dupKeyFor,
} from "./seatbelt.js";

/** A controllable clock: `now()` reads it, `set`/`advance` move it. */
function fakeClock(start = 1_000_000): {
  now: () => number;
  set: (t: number) => void;
  advance: (dt: number) => void;
} {
  let t = start;
  return {
    now: () => t,
    set: (v) => {
      t = v;
    },
    advance: (dt) => {
      t += dt;
    },
  };
}

const CH = "incident-1";
const A = "agent-a";

describe("constants", () => {
  it("expose the documented defaults", () => {
    expect(DEFAULT_MAX_POSTS_PER_MINUTE).toBe(30);
    expect(DEFAULT_DUP_WINDOW).toBe(1);
    expect(SEATBELT_WINDOW_MS).toBe(60_000);
  });
});

describe("rate limit — cap trips at N+1", () => {
  it("admits exactly `maxPostsPerMinute`, then throws RateLimitedError", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ maxPostsPerMinute: 3, clock: clock.now });

    // 3 posts at the same instant all admit.
    for (let i = 0; i < 3; i++) {
      expect(() => sb.admit(CH, A, dupKeyFor("note", `m${i}`), clock.now())).not.toThrow();
    }
    // The 4th trips the cap.
    let thrown: unknown;
    try {
      sb.admit(CH, A, dupKeyFor("note", "m3"), clock.now());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect((thrown as RateLimitedError).code).toBe("rate_limited");
    expect((thrown as RateLimitedError).limit).toBe(3);
  });

  it("retryAfterMs = oldestKept + windowMs - now", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ maxPostsPerMinute: 2, windowMs: 60_000, clock: clock.now });

    sb.recordRate(CH, A, 0); // oldest kept
    clock.set(10_000);
    sb.recordRate(CH, A, 10_000);

    clock.set(20_000); // now at cap (2 in window)
    let thrown: RateLimitedError | undefined;
    try {
      sb.checkRate(CH, A, clock.now());
    } catch (e) {
      thrown = e as RateLimitedError;
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    // oldest(0) + window(60000) - now(20000) = 40000
    expect(thrown!.retryAfterMs).toBe(40_000);
    // The actionable message rounds to whole seconds.
    expect(thrown!.message).toContain("Wait ~40s");
    expect(thrown!.message).toContain("at most 2 posts/min");
  });
});

describe("rate limit — window slides", () => {
  it("a post older than the window no longer counts; a fresh slot opens", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ maxPostsPerMinute: 2, windowMs: 60_000, clock: clock.now });

    sb.recordRate(CH, A, 0);
    sb.recordRate(CH, A, 1_000);

    // At now=30_000 both still in window → at cap.
    clock.set(30_000);
    expect(() => sb.checkRate(CH, A, clock.now())).toThrow(RateLimitedError);

    // Advance past the window for the first post: it ages out, leaving 1 → admits.
    clock.set(60_001);
    expect(() => sb.checkRate(CH, A, clock.now())).not.toThrow();
  });

  it("entries exactly at the cutoff (now - windowMs) are dropped", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ maxPostsPerMinute: 1, windowMs: 60_000, clock: clock.now });
    sb.recordRate(CH, A, 0);
    // now - window = 0, the post at 0 is at the cutoff and is dropped → admits.
    clock.set(60_000);
    expect(() => sb.checkRate(CH, A, clock.now())).not.toThrow();
  });
});

describe("rate limit — per-(channel, agent) isolation", () => {
  it("a different agent on the same channel has its own budget", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ maxPostsPerMinute: 1, clock: clock.now });
    sb.recordRate(CH, A, clock.now());
    expect(() => sb.checkRate(CH, A, clock.now())).toThrow(RateLimitedError);
    // agent-b unaffected.
    expect(() => sb.checkRate(CH, "agent-b", clock.now())).not.toThrow();
  });

  it("the same agent on a different channel has its own budget", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ maxPostsPerMinute: 1, clock: clock.now });
    sb.recordRate(CH, A, clock.now());
    expect(() => sb.checkRate(CH, A, clock.now())).toThrow(RateLimitedError);
    expect(() => sb.checkRate("incident-2", A, clock.now())).not.toThrow();
  });
});

describe("checkRate records nothing (the claim-loser split)", () => {
  it("repeated checkRate without recordRate never trips", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ maxPostsPerMinute: 1, clock: clock.now });
    for (let i = 0; i < 5; i++) {
      expect(() => sb.checkRate(CH, A, clock.now())).not.toThrow();
    }
  });
});

describe("loop / duplicate detection", () => {
  it("blocks an identical consecutive post (same type + body)", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ clock: clock.now });
    sb.admit(CH, A, dupKeyFor("note", "hello"), clock.now());
    expect(() => sb.admit(CH, A, dupKeyFor("note", "hello"), clock.now())).toThrow(
      DuplicatePostError,
    );
  });

  it("trims whitespace — a whitespace-only variation still counts as a dup", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ clock: clock.now });
    sb.admit(CH, A, dupKeyFor("note", "hello"), clock.now());
    expect(() =>
      sb.admit(CH, A, dupKeyFor("note", "  hello  "), clock.now()),
    ).toThrow(DuplicatePostError);
  });

  it("varied body passes", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ clock: clock.now });
    sb.admit(CH, A, dupKeyFor("note", "hello"), clock.now());
    expect(() => sb.admit(CH, A, dupKeyFor("note", "world"), clock.now())).not.toThrow();
  });

  it("same body but different type passes", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ clock: clock.now });
    sb.admit(CH, A, dupKeyFor("note", "hello"), clock.now());
    expect(() =>
      sb.admit(CH, A, dupKeyFor("finding", "hello"), clock.now()),
    ).not.toThrow();
  });

  it("A-B-A (non-consecutive repeat) passes — only the immediately-previous post counts", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ clock: clock.now });
    sb.admit(CH, A, dupKeyFor("note", "A"), clock.now());
    sb.admit(CH, A, dupKeyFor("note", "B"), clock.now());
    expect(() => sb.admit(CH, A, dupKeyFor("note", "A"), clock.now())).not.toThrow();
  });

  it("a rejected dup does not become the new baseline (rate not charged either)", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ maxPostsPerMinute: 10, clock: clock.now });
    sb.admit(CH, A, dupKeyFor("note", "A"), clock.now());
    // This dup throws...
    expect(() => sb.admit(CH, A, dupKeyFor("note", "A"), clock.now())).toThrow(
      DuplicatePostError,
    );
    // ...and the original "A" is still the baseline, so "A" again still throws,
    // while "B" passes (proving the rejected attempt recorded nothing).
    expect(() => sb.admit(CH, A, dupKeyFor("note", "A"), clock.now())).toThrow(
      DuplicatePostError,
    );
    expect(() => sb.admit(CH, A, dupKeyFor("note", "B"), clock.now())).not.toThrow();
  });

  it("duplicate detection is per-(channel, agent)", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ clock: clock.now });
    sb.admit(CH, A, dupKeyFor("note", "hello"), clock.now());
    // Same content, different agent → not a dup.
    expect(() =>
      sb.admit(CH, "agent-b", dupKeyFor("note", "hello"), clock.now()),
    ).not.toThrow();
    // Same content, different channel → not a dup.
    expect(() =>
      sb.admit("incident-2", A, dupKeyFor("note", "hello"), clock.now()),
    ).not.toThrow();
  });
});

describe("admit ordering — rate is checked before dup, and nothing records on a throw", () => {
  it("an over-cap dup surfaces as RateLimitedError and records nothing", () => {
    const clock = fakeClock();
    const sb = new Seatbelt({ maxPostsPerMinute: 1, clock: clock.now });
    sb.admit(CH, A, dupKeyFor("note", "x"), clock.now()); // fills the 1 slot
    // Next admit is BOTH over-cap and a dup; rate is checked first.
    expect(() => sb.admit(CH, A, dupKeyFor("note", "x"), clock.now())).toThrow(
      RateLimitedError,
    );
  });
});

describe("defaults never throttle a handful of varied posts", () => {
  it("admits many distinct posts under the default cap", () => {
    const sb = new Seatbelt(); // real Date.now clock, default cap 30
    for (let i = 0; i < 10; i++) {
      expect(() => sb.admit(CH, A, dupKeyFor("finding", `finding ${i}`), Date.now())).not.toThrow();
    }
  });
});

describe("dupKeyFor", () => {
  it("composes type + trimmed body", () => {
    expect(dupKeyFor("note", "  hi  ")).toBe("note hi");
    expect(dupKeyFor("finding", "x")).toBe("finding x");
  });
});

// ---------------------------------------------------------------------------
// CAU-74 — resource caps & eviction: idle eviction (lazy sweep), the LRU
// backstop, the cross-channel global rate counter, and the create throttle.
// ---------------------------------------------------------------------------

describe("CAU-74 constants", () => {
  it("expose the documented defaults", () => {
    expect(DEFAULT_GLOBAL_RATE_MULTIPLIER).toBe(4);
    expect(DEFAULT_MAX_CHANNEL_CREATES_PER_MINUTE).toBe(10);
    expect(DEFAULT_MAX_TRACKED_AGENTS).toBe(4096);
  });
});

describe("idle eviction (CAU-74) — lazy sweep, once per window", () => {
  it("evicts a fully-idle entry after a quiet window; the dup baseline is forgotten", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ windowMs: 60_000, clock: clock.now });

    sb.admit(CH, A, dupKeyFor("note", "same"), clock.now());
    // One (channel, agent) entry + one global entry.
    expect(sb.trackedEntryCount).toBe(2);
    // The dup baseline is live: an immediate identical repeat is blocked.
    expect(() => sb.admit(CH, A, dupKeyFor("note", "same"), clock.now())).toThrow(
      DuplicatePostError,
    );

    // Within the window a mutator runs but the sweep does NOT (once per window):
    // nothing is evicted yet.
    clock.set(59_999);
    sb.recordRate(CH, "agent-b", clock.now());
    expect(sb.trackedEntryCount).toBe(4);

    // Past a full quiet window for A: the next mutator's sweep prunes A's
    // window empty and evicts the idle entries (A and agent-b both).
    clock.set(120_001);
    sb.recordRate(CH, "agent-probe", clock.now());
    expect(sb.trackedEntryCount).toBe(2); // only agent-probe's two entries

    // Dup-forgetting nuance (documented): A's identical re-post more than a
    // window after the original is ADMITTED — ADR-C8 targets consecutive
    // loops, not 60s-quiet repeats.
    expect(() =>
      sb.admit(CH, A, dupKeyFor("note", "same"), clock.now()),
    ).not.toThrow();
    expect(sb.trackedEntryCount).toBe(4);
  });

  it("does NOT evict an entry with in-window posts", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ windowMs: 60_000, clock: clock.now });

    sb.admit(CH, A, dupKeyFor("note", "first"), clock.now());
    clock.set(50_000);
    sb.admit(CH, A, dupKeyFor("note", "second"), clock.now());

    // At 100_000 the sweep runs: the post at 50_000 is still in-window, so the
    // entry survives — and its dup baseline still blocks.
    clock.set(100_000);
    expect(() =>
      sb.admit(CH, A, dupKeyFor("note", "second"), clock.now()),
    ).toThrow(DuplicatePostError);
  });

  it("does NOT evict a rate-limited spammer's entry — lastActivity updates on every access", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ maxPostsPerMinute: 1, windowMs: 60_000, clock: clock.now });

    sb.admit(CH, A, dupKeyFor("note", "spam"), clock.now());
    // At 30_000 the spammer retries and is rate-limited; the rejected access
    // still TOUCHES the entry (lastActivity = 30_000).
    clock.set(30_000);
    expect(() => sb.admit(CH, A, dupKeyFor("note", "spam"), clock.now())).toThrow(
      RateLimitedError,
    );

    // At 70_000 the sweep prunes the window empty, but the entry was touched
    // 40s ago (< window) so it is NOT evicted: the dup baseline still blocks
    // even though the rate window has slid open.
    clock.set(70_000);
    expect(() => sb.admit(CH, A, dupKeyFor("note", "spam"), clock.now())).toThrow(
      DuplicatePostError,
    );
  });
});

describe("LRU backstop (CAU-74) — maxTrackedAgents per internal map", () => {
  it("evicts the least-recently-used entry once the cap is exceeded", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ maxTrackedAgents: 2, clock: clock.now });

    sb.admit(CH, "agent-a", dupKeyFor("note", "ping"), clock.now());
    sb.admit(CH, "agent-b", dupKeyFor("note", "ping"), clock.now());
    sb.admit(CH, "agent-c", dupKeyFor("note", "ping"), clock.now());

    // The cap applies to EACH map independently: 2 per-(channel, agent)
    // entries + 2 global entries remain (agent-a's were evicted from both).
    expect(sb.trackedEntryCount).toBe(4);

    // agent-a's entry (the LRU) was evicted, so its dup baseline is gone: the
    // identical re-post passes.
    expect(() =>
      sb.admit(CH, "agent-a", dupKeyFor("note", "ping"), clock.now()),
    ).not.toThrow();
    // agent-c's entry is still tracked: its identical re-post still blocks.
    expect(() =>
      sb.admit(CH, "agent-c", dupKeyFor("note", "ping"), clock.now()),
    ).toThrow(DuplicatePostError);
    expect(sb.trackedEntryCount).toBe(4);
  });
});

describe("global cross-channel rate cap (CAU-74)", () => {
  it("caps one agent's posts ACROSS channels even when each channel has budget left", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({
      maxPostsPerMinute: 5,
      globalMaxPostsPerMinute: 8,
      clock: clock.now,
    });

    // 5 posts on ch-A (per-channel cap reached there), then 3 on ch-B: all ok.
    for (let i = 0; i < 5; i++) {
      sb.admit("ch-a", A, dupKeyFor("note", `a${i}`), clock.now());
    }
    for (let i = 0; i < 3; i++) {
      sb.admit("ch-b", A, dupKeyFor("note", `b${i}`), clock.now());
    }

    // The 4th on ch-B has per-channel room (3 < 5) but the GLOBAL budget (8)
    // is spent: rate_limited with the distinct cross-channel message.
    let thrown: RateLimitedError | undefined;
    try {
      sb.admit("ch-b", A, dupKeyFor("note", "b3"), clock.now());
    } catch (e) {
      thrown = e as RateLimitedError;
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(thrown!.code).toBe("rate_limited");
    expect(thrown!.scope).toBe("global");
    expect(thrown!.limit).toBe(8);
    expect(thrown!.message).toContain("at most 8 posts/min per agent across all channels");

    // Another agent is unaffected (global budget is per-agent).
    expect(() =>
      sb.admit("ch-b", "agent-b", dupKeyFor("note", "hi"), clock.now()),
    ).not.toThrow();

    // The window slides: a minute later BOTH budgets are free again.
    clock.advance(60_001);
    expect(() =>
      sb.admit("ch-b", A, dupKeyFor("note", "fresh"), clock.now()),
    ).not.toThrow();
  });

  it("defaults the global cap to 4× the effective per-channel cap", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ maxPostsPerMinute: 2, clock: clock.now });

    // Derived global cap = 2 × 4 = 8: two posts on each of four channels fit…
    for (let ch = 0; ch < 4; ch++) {
      for (let i = 0; i < 2; i++) {
        sb.admit(`ch-${ch}`, A, dupKeyFor("note", `m${ch}-${i}`), clock.now());
      }
    }
    // …and the 9th post (on a FIFTH channel, per-channel budget untouched)
    // trips the derived global cap.
    let thrown: RateLimitedError | undefined;
    try {
      sb.admit("ch-4", A, dupKeyFor("note", "over"), clock.now());
    } catch (e) {
      thrown = e as RateLimitedError;
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(thrown!.scope).toBe("global");
    expect(thrown!.limit).toBe(2 * DEFAULT_GLOBAL_RATE_MULTIPLIER);
  });

  it("an explicitly supplied global cap wins as-given (no multiplier)", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({
      maxPostsPerMinute: 2,
      globalMaxPostsPerMinute: 3,
      clock: clock.now,
    });
    sb.admit("ch-a", A, dupKeyFor("note", "1"), clock.now());
    sb.admit("ch-a", A, dupKeyFor("note", "2"), clock.now());
    sb.admit("ch-b", A, dupKeyFor("note", "3"), clock.now());
    let thrown: RateLimitedError | undefined;
    try {
      sb.checkRate("ch-b", A, clock.now());
    } catch (e) {
      thrown = e as RateLimitedError;
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(thrown!.scope).toBe("global");
    expect(thrown!.limit).toBe(3);
  });

  it("checkRate records nothing against the global budget either (claim-loser split)", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ globalMaxPostsPerMinute: 1, clock: clock.now });
    for (let i = 0; i < 5; i++) {
      expect(() => sb.checkRate(CH, A, clock.now())).not.toThrow();
    }
  });
});

describe("admitChannelCreate (CAU-74) — per-creator create throttle", () => {
  it("admits exactly the cap, then throws rate_limited (scope create) with retryAfterMs", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({
      maxChannelCreatesPerMinute: 2,
      windowMs: 60_000,
      clock: clock.now,
    });

    sb.admitChannelCreate("alice", 0);
    clock.set(10_000);
    sb.admitChannelCreate("alice", 10_000);

    clock.set(20_000);
    let thrown: RateLimitedError | undefined;
    try {
      sb.admitChannelCreate("alice", 20_000);
    } catch (e) {
      thrown = e as RateLimitedError;
    }
    expect(thrown).toBeInstanceOf(RateLimitedError);
    expect(thrown!.code).toBe("rate_limited");
    expect(thrown!.scope).toBe("create");
    expect(thrown!.limit).toBe(2);
    // oldest(0) + window(60000) - now(20000) = 40000.
    expect(thrown!.retryAfterMs).toBe(40_000);
    expect(thrown!.message).toContain("at most 2 channel creates/min per owner");
  });

  it("is isolated per creator", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({ maxChannelCreatesPerMinute: 1, clock: clock.now });
    sb.admitChannelCreate("alice", clock.now());
    expect(() => sb.admitChannelCreate("alice", clock.now())).toThrow(RateLimitedError);
    expect(() => sb.admitChannelCreate("bob", clock.now())).not.toThrow();
  });

  it("the window slides — a create ages out and frees a slot", () => {
    const clock = fakeClock(0);
    const sb = new Seatbelt({
      maxChannelCreatesPerMinute: 1,
      windowMs: 60_000,
      clock: clock.now,
    });
    sb.admitChannelCreate("alice", clock.now());
    expect(() => sb.admitChannelCreate("alice", clock.now())).toThrow(RateLimitedError);
    clock.set(60_001);
    expect(() => sb.admitChannelCreate("alice", clock.now())).not.toThrow();
  });
});
