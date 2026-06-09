import { describe, expect, it, vi } from "vitest";
import {
  CHANNEL,
  isWatchAll,
  parseArgs,
  resolveChannel,
  resolveUrl,
  WATCH_ALL_FLAG,
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
  it("captures a CHANNEL= override", () => {
    expect(parseArgs(["CHANNEL=dogfood"])).toEqual({ CHANNEL: "dogfood" });
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
    expect(parseArgs(["PORT=4747", "CHANNEL=x"])).toEqual({
      PORT: "4747",
      CHANNEL: "x",
    });
    expect(resolveUrl({}, { PORT: "4747" })).toBe("http://127.0.0.1:4747");
  });
});
