import { describe, expect, it } from "vitest";

import { DEFAULT_CAUCUS_URL, loadHookConfig } from "./config.js";

describe("loadHookConfig", () => {
  it("defaults the url and treats a missing channel as a no-op signal", () => {
    const cfg = loadHookConfig({});
    expect(cfg.url).toBe(DEFAULT_CAUCUS_URL);
    expect(cfg.channel).toBe("");
    expect(cfg.token).toBe("");
  });

  it("reads CAUCUS_URL / CAUCUS_CHANNEL / CAUCUS_TOKEN", () => {
    const cfg = loadHookConfig({
      CAUCUS_URL: "http://localhost:9999",
      CAUCUS_CHANNEL: "incident-42",
      CAUCUS_TOKEN: "tok-abc",
    });
    expect(cfg.url).toBe("http://localhost:9999");
    expect(cfg.channel).toBe("incident-42");
    expect(cfg.token).toBe("tok-abc");
  });

  it("trims surrounding whitespace and treats all-whitespace as unset", () => {
    const cfg = loadHookConfig({
      CAUCUS_URL: "  http://h:1  ",
      CAUCUS_CHANNEL: "   ",
      CAUCUS_TOKEN: "\t",
    });
    expect(cfg.url).toBe("http://h:1");
    expect(cfg.channel).toBe("");
    expect(cfg.token).toBe("");
  });

  it("falls back to the default url for an empty CAUCUS_URL", () => {
    expect(loadHookConfig({ CAUCUS_URL: "" }).url).toBe(DEFAULT_CAUCUS_URL);
  });

  it("never throws on a missing channel (fail open, not an exception)", () => {
    expect(() => loadHookConfig({ CAUCUS_URL: "http://x" })).not.toThrow();
  });
});
