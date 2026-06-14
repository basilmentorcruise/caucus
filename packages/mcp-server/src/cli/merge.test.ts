import { describe, expect, it } from "vitest";

import { buildHookMatcher, buildMcpEntry, type ScaffoldValues } from "./generate.js";
import {
  mergeMcp,
  mergeSettings,
  planEnvFile,
  planJsonFile,
  serialize,
} from "./merge.js";

const VALUES: ScaffoldValues = {
  url: "http://127.0.0.1:4747",
  channel: "incident-42",
  mcpServerBin: "/abs/mcp/dist/index.js",
  hookBin: "/abs/hook/dist/bin.js",
  tokenEnv: "CAUCUS_TOKEN",
};
const ENTRY = buildMcpEntry(VALUES);
const MATCHER = buildHookMatcher(VALUES);

describe("serialize", () => {
  it("is stable 2-space JSON with a trailing newline", () => {
    expect(serialize({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});

describe("mergeMcp", () => {
  it("preserves other mcpServers and unrelated top-level keys", () => {
    const existing = {
      mcpServers: { other: { command: "x" } },
      somethingElse: { keep: true },
    };
    const merged = mergeMcp(existing, ENTRY);
    expect((merged.mcpServers as Record<string, unknown>).other).toEqual({ command: "x" });
    expect((merged.mcpServers as Record<string, unknown>).caucus).toEqual(ENTRY);
    expect(merged.somethingElse).toEqual({ keep: true });
  });

  it("creates mcpServers when absent or non-object", () => {
    expect((mergeMcp({}, ENTRY).mcpServers as Record<string, unknown>).caucus).toEqual(ENTRY);
    expect(
      (mergeMcp({ mcpServers: 7 }, ENTRY).mcpServers as Record<string, unknown>).caucus,
    ).toEqual(ENTRY);
  });

  it("replaces an existing caucus entry in place (idempotent shape)", () => {
    const merged = mergeMcp({ mcpServers: { caucus: { command: "stale" } } }, ENTRY);
    expect((merged.mcpServers as Record<string, unknown>).caucus).toEqual(ENTRY);
  });
});

describe("mergeSettings", () => {
  it("preserves permissions and other hook matchers/events", () => {
    const existing = {
      permissions: { allow: ["Bash(ls)"] },
      hooks: {
        UserPromptSubmit: [
          { matcher: "Edit", hooks: [{ type: "command", command: "node other.js" }] },
        ],
        PostToolUse: [{ matcher: "", hooks: [{ type: "command", command: "node x.js" }] }],
      },
    };
    const merged = mergeSettings(existing, MATCHER);
    expect(merged.permissions).toEqual({ allow: ["Bash(ls)"] });
    const hooks = merged.hooks as Record<string, unknown[]>;
    // The unrelated UserPromptSubmit matcher survives; ours is appended.
    expect(hooks.UserPromptSubmit).toHaveLength(2);
    expect(hooks.UserPromptSubmit).toContainEqual(existing.hooks.UserPromptSubmit[0]);
    expect(hooks.UserPromptSubmit).toContainEqual(MATCHER);
    // The other event is untouched.
    expect(hooks.PostToolUse).toEqual(existing.hooks.PostToolUse);
  });

  it("replaces our own matcher in place on re-run (no duplicate)", () => {
    const once = mergeSettings({}, MATCHER);
    const twice = mergeSettings(once, MATCHER);
    expect((twice.hooks as Record<string, unknown[]>).UserPromptSubmit).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  it("unions caucus into enabledMcpjsonServers only when the key is used", () => {
    // Absent → seeded.
    expect(mergeSettings({}, MATCHER).enabledMcpjsonServers).toEqual(["caucus"]);
    // Present → union without duplicate, preserving order/others.
    expect(
      mergeSettings({ enabledMcpjsonServers: ["foo"] }, MATCHER).enabledMcpjsonServers,
    ).toEqual(["foo", "caucus"]);
    expect(
      mergeSettings({ enabledMcpjsonServers: ["caucus"] }, MATCHER).enabledMcpjsonServers,
    ).toEqual(["caucus"]);
  });

  it("leaves a non-array enabledMcpjsonServers untouched (no clobber)", () => {
    const merged = mergeSettings({ enabledMcpjsonServers: "garbage" }, MATCHER);
    expect(merged.enabledMcpjsonServers).toBe("garbage");
  });

  it("keeps malformed/foreign UserPromptSubmit matchers (null, wrong matcher, non-array hooks)", () => {
    const existing = {
      hooks: {
        UserPromptSubmit: [
          null, // not an object
          { matcher: "Edit", hooks: [{ command: MATCHER.hooks[0].command }] }, // non-empty matcher
          { matcher: "", hooks: "nope" }, // hooks not an array
          { matcher: "", hooks: [{ command: "node SOMETHING-ELSE.js" }] }, // empty matcher, different command
        ],
      },
    };
    const merged = mergeSettings(existing, MATCHER);
    const ups = (merged.hooks as Record<string, unknown[]>).UserPromptSubmit;
    // None of the four are OUR matcher, so all are kept and ours is appended.
    expect(ups).toHaveLength(5);
    expect(ups).toContainEqual(MATCHER);
  });

  it("treats a non-object hooks value as empty", () => {
    const merged = mergeSettings({ hooks: 7 }, MATCHER);
    expect((merged.hooks as Record<string, unknown[]>).UserPromptSubmit).toEqual([MATCHER]);
  });
});

describe("planJsonFile", () => {
  const build = (existing: Record<string, unknown>): unknown => mergeMcp(existing, ENTRY);

  it("create when the file is absent", () => {
    const plan = planJsonFile(undefined, build);
    expect(plan.action).toBe("create");
    expect(plan.backup).toBe(false);
    expect(plan.content).toContain("${CAUCUS_TOKEN}");
  });

  it("noop when the existing content already equals the merge result", () => {
    const created = planJsonFile(undefined, build).content!;
    const plan = planJsonFile(created, build);
    expect(plan.action).toBe("noop");
    expect(plan.backup).toBe(false);
    expect(plan.content).toBeUndefined();
  });

  it("merge (with backup) when valid JSON differs", () => {
    const plan = planJsonFile(serialize({ mcpServers: { other: { command: "x" } } }), build);
    expect(plan.action).toBe("merge");
    expect(plan.backup).toBe(true);
    expect(plan.content).toContain('"other"');
    expect(plan.content).toContain('"caucus"');
  });

  it("recreate (with backup) when JSON is corrupt — never merges into garbage", () => {
    const plan = planJsonFile("{ this is not json", build);
    expect(plan.action).toBe("recreate");
    expect(plan.backup).toBe(true);
    // Built fresh from {}, so it carries only the caucus entry.
    expect(plan.content).toContain('"caucus"');
    expect(plan.content).not.toContain("this is not json");
  });

  it("treats a valid-but-non-object JSON (array) as an empty base", () => {
    const plan = planJsonFile("[1,2,3]", build);
    expect(plan.action).toBe("merge");
    expect(plan.content).toContain('"caucus"');
  });
});

describe("planEnvFile", () => {
  it("absent → create; identical → noop", () => {
    expect(planEnvFile(undefined, "X").action).toBe("create");
    expect(planEnvFile("X", "X").action).toBe("noop");
  });

  it("differs → skip (never backed up, never rewritten — it holds the user's secret, ADR-C12)", () => {
    const m = planEnvFile("OLD", "NEW");
    expect(m.action).toBe("skip");
    expect(m.backup).toBe(false);
    // No content to write: the existing file is left exactly as-is.
    expect(m.content).toBeUndefined();
  });
});
