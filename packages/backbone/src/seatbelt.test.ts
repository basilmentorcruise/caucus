/**
 * Unit tests for the seatbelt (ADR-C8): the per-agent rate-limit sliding window
 * and the consecutive-duplicate (loop) detector. The clock is injected so window
 * behavior is deterministic with no real waits.
 */
import { describe, expect, it } from "vitest";

import { DuplicatePostError, RateLimitedError } from "./errors.js";
import {
  DEFAULT_DUP_WINDOW,
  DEFAULT_MAX_POSTS_PER_MINUTE,
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
