import { describe, expect, it } from "vitest";

import * as hook from "./index.js";

describe("@caucus/hook public surface", () => {
  it("re-exports the config, checkpoint, render, and run entrypoints", () => {
    expect(typeof hook.loadHookConfig).toBe("function");
    expect(typeof hook.checkpointPath).toBe("function");
    expect(typeof hook.readCheckpoint).toBe("function");
    expect(typeof hook.writeCheckpoint).toBe("function");
    expect(typeof hook.renderMessage).toBe("function");
    expect(typeof hook.renderDelta).toBe("function");
    expect(typeof hook.parseHookInput).toBe("function");
    expect(typeof hook.runHook).toBe("function");
  });

  it("re-exports the shared constants", () => {
    expect(typeof hook.DEFAULT_CAUCUS_URL).toBe("string");
    expect(typeof hook.BODY_TRUNCATE_CHARS).toBe("number");
    expect(typeof hook.HOOK_TIMEOUT_MS).toBe("number");
    expect(hook.DELTA_HEADER).toContain("CAUCUS");
    expect(hook.DELTA_FOOTER).toContain("CAUCUS");
  });
});
