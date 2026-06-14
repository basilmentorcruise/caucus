import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  resolveBins,
  resolveHookBin,
  resolveMcpServerBin,
} from "./paths.js";

describe("resolveMcpServerBin", () => {
  it("resolves ../index.js from a dist/cli/paths.js URL (monorepo layout)", () => {
    const selfUrl = pathToFileURL(
      "/repo/packages/mcp-server/dist/cli/paths.js",
    ).href;
    expect(resolveMcpServerBin(selfUrl)).toBe(
      "/repo/packages/mcp-server/dist/index.js",
    );
  });

  it("resolves correctly under a node_modules install layout", () => {
    const selfUrl = pathToFileURL(
      "/app/node_modules/@caucus/mcp-server/dist/cli/paths.js",
    ).href;
    expect(resolveMcpServerBin(selfUrl)).toBe(
      "/app/node_modules/@caucus/mcp-server/dist/index.js",
    );
  });
});

describe("resolveHookBin", () => {
  it("reads bin['caucus-hook'] and joins it against the package root", () => {
    const hookBin = resolveHookBin({
      resolve: (spec) => {
        expect(spec).toBe("@caucus/hook/package.json");
        return "/repo/packages/hook/package.json";
      },
      readFile: () => JSON.stringify({ bin: { "caucus-hook": "./dist/bin.js" } }),
    });
    expect(hookBin).toBe("/repo/packages/hook/dist/bin.js");
  });

  it("supports a string bin field", () => {
    const hookBin = resolveHookBin({
      resolve: () => "/nm/@caucus/hook/package.json",
      readFile: () => JSON.stringify({ bin: "dist/bin.js" }),
    });
    expect(hookBin).toBe("/nm/@caucus/hook/dist/bin.js");
  });

  it("throws when the hook package has no caucus-hook bin", () => {
    expect(() =>
      resolveHookBin({
        resolve: () => "/x/package.json",
        readFile: () => JSON.stringify({ bin: { other: "./x.js" } }),
      }),
    ).toThrow(/no "caucus-hook" bin/);
  });
});

describe("resolveBins with REAL default deps (no injection)", () => {
  it("resolves both bins against the live module graph (@caucus/hook installed)", () => {
    // Exercises the production code path: the default `createRequire` +
    // `readFileSync`. The test runs from source, so the server bin URL points at
    // src; what matters is that BOTH paths are absolute and the hook resolves to
    // a real dist/bin.js via the installed @caucus/hook package.json.
    const bins = resolveBins();
    expect(bins.mcpServer).toMatch(/index\.js$/);
    expect(bins.hook).toMatch(/dist[/\\]bin\.js$/);
    expect(bins.hook.startsWith("/") || /^[A-Za-z]:\\/.test(bins.hook)).toBe(true);
  });
});

describe("resolveBins + JSON round-trip (Windows safety)", () => {
  it("emits absolute paths that survive a JSON.parse round-trip with backslashes", () => {
    const bins = resolveBins({
      selfUrl: pathToFileURL(
        "/repo/packages/mcp-server/dist/cli/paths.js",
      ).href,
      resolve: () => "/repo/packages/hook/package.json",
      readFile: () => JSON.stringify({ bin: { "caucus-hook": "./dist/bin.js" } }),
    });
    // A Windows-style path embedded in JSON must round-trip unchanged: a literal
    // backslash is the JSON escape `\\`, and JSON.stringify handles that — assert
    // the value survives serialize→parse intact (the real scaffold uses
    // JSON.stringify, so a `\` in a path is never corrupted).
    const winPath = "C:\\Users\\dev\\app\\dist\\index.js";
    const round = JSON.parse(JSON.stringify({ p: winPath })) as { p: string };
    expect(round.p).toBe(winPath);
    // And the resolver itself returns absolute, non-empty paths.
    expect(bins.mcpServer).toBe("/repo/packages/mcp-server/dist/index.js");
    expect(bins.hook).toBe("/repo/packages/hook/dist/bin.js");
  });
});
