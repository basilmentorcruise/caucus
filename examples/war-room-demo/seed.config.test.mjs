import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL,
  isWatchAll,
  parseArgs,
  resolveChannel,
  resolveUrl,
  URL_ARG_KEYS,
  WATCH_ALL_FLAG,
  WATCH_ARG_KEYS,
} from "./seed.config.mjs";

// CAU-67 — generic channel selection for the human watcher. Mirrors the
// precedence already proven for resolveUrl (arg > env > default).

describe("resolveChannel", () => {
  it("defaults to the demo channel when nothing is set", () => {
    expect(resolveChannel({}, {})).toBe(CHANNEL);
  });

  it("uses CAUCUS_CHANNEL from the environment", () => {
    expect(resolveChannel({ CAUCUS_CHANNEL: "dogfood" }, {})).toBe("dogfood");
  });

  it("lets a make-style CHANNEL= arg override beat the environment", () => {
    expect(
      resolveChannel({ CAUCUS_CHANNEL: "from-env" }, { CHANNEL: "from-arg" }),
    ).toBe("from-arg");
  });

  it("treats a blank value as unset (make watch CHANNEL=)", () => {
    expect(resolveChannel({ CAUCUS_CHANNEL: "" }, {})).toBe(CHANNEL);
    expect(resolveChannel({}, { CHANNEL: "   " })).toBe(CHANNEL);
  });

  it("trims surrounding whitespace", () => {
    expect(resolveChannel({}, { CHANNEL: "  room-1 " })).toBe("room-1");
  });
});

describe("isWatchAll", () => {
  it("is false for a normal single-channel run", () => {
    expect(isWatchAll([], {}, {})).toBe(false);
    expect(isWatchAll([], { CAUCUS_CHANNEL: "dogfood" }, {})).toBe(false);
  });

  it("is true with the --all flag", () => {
    expect(isWatchAll([WATCH_ALL_FLAG], {}, {})).toBe(true);
  });

  it("is true when the resolved channel is the * sentinel (CHANNEL='*')", () => {
    expect(isWatchAll([], {}, { CHANNEL: "*" })).toBe(true);
    expect(isWatchAll([], { CAUCUS_CHANNEL: "*" }, {})).toBe(true);
  });
});

describe("parseArgs — watch additions", () => {
  it("captures a CHANNEL= override when the script honors it (watch keys)", () => {
    expect(parseArgs(["CHANNEL=dogfood"], [], WATCH_ARG_KEYS)).toEqual({
      CHANNEL: "dogfood",
    });
  });

  it("accepts --all as a recognized flag, not an unknown arg", () => {
    expect(parseArgs([WATCH_ALL_FLAG], [WATCH_ALL_FLAG])).toEqual({});
  });

  it("still rejects genuinely unknown args loudly (CAU-61)", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseArgs(["--bogus"])).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(2);
    exit.mockRestore();
    err.mockRestore();
  });

  it("still resolves URL overrides alongside the new ones", () => {
    expect(parseArgs(["PORT=4747", "CHANNEL=x"], [], WATCH_ARG_KEYS)).toEqual({
      PORT: "4747",
      CHANNEL: "x",
    });
    expect(resolveUrl({}, { PORT: "4747" })).toBe("http://127.0.0.1:4747");
  });
});

// CAU-76 — per-script key scoping: a `VAR=` override a script parses but never
// applies must be rejected loudly, never silently swallowed (the CAU-61 class).
describe("parseArgs — per-script key scoping (CAU-76)", () => {
  it("defaults to the URL keys only (seed.mjs / demo.mjs scope)", () => {
    expect(URL_ARG_KEYS).toEqual(["PORT", "CAUCUS_URL"]);
    expect(parseArgs(["PORT=4747", "CAUCUS_URL=http://127.0.0.1:9"])).toEqual({
      PORT: "4747",
      CAUCUS_URL: "http://127.0.0.1:9",
    });
  });

  it("rejects CHANNEL= loudly under the default (seed/demo) scope", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => parseArgs(["CHANNEL=dogfood"])).toThrow("exit");
    expect(exit).toHaveBeenCalledWith(2);
    // The rejection is actionable: it names the offender and what IS supported.
    const message = err.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(message).toContain("CHANNEL=dogfood");
    expect(message).toContain("PORT=");
    exit.mockRestore();
    err.mockRestore();
  });

  it("the watch scope is the URL scope plus CHANNEL", () => {
    expect(WATCH_ARG_KEYS).toEqual([...URL_ARG_KEYS, "CHANNEL"]);
  });
});
