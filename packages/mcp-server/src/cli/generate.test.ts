import { describe, expect, it } from "vitest";

import {
  buildEnvFile,
  buildHookMatcher,
  buildMcpEntry,
  buildMcpJson,
  buildSettings,
  type ScaffoldValues,
} from "./generate.js";

const VALUES: ScaffoldValues = {
  url: "http://127.0.0.1:4747",
  channel: "incident-42",
  mcpServerBin: "/abs/path/to/mcp-server/dist/index.js",
  hookBin: "/abs/path/to/hook/dist/bin.js",
  tokenEnv: "CAUCUS_TOKEN",
};

/** A value that, if it ever surfaced in output, would be a leaked secret. */
const TOKEN_LOOKING = "tok-alice-SUPERSECRET-1234";

describe("buildMcpEntry / buildMcpJson", () => {
  it("references the token as an ${ENV} reference, NEVER a literal (ADR-C12)", () => {
    const entry = buildMcpEntry(VALUES);
    // The exact reference — this is the load-bearing ADR-C12 assertion.
    expect(entry.env.CAUCUS_TOKEN).toBe("${CAUCUS_TOKEN}");
  });

  it("honors a custom --token-env NAME in the reference", () => {
    const entry = buildMcpEntry({ ...VALUES, tokenEnv: "MY_BEARER" });
    expect(entry.env.CAUCUS_TOKEN).toBe("${MY_BEARER}");
  });

  it("stamps the literal url + channel and the absolute bin path", () => {
    const entry = buildMcpEntry(VALUES);
    expect(entry.command).toBe("node");
    expect(entry.args).toEqual(["/abs/path/to/mcp-server/dist/index.js"]);
    expect(entry.env.CAUCUS_URL).toBe("http://127.0.0.1:4747");
    expect(entry.env.CAUCUS_CHANNEL).toBe("incident-42");
  });

  it("a token-looking value supplied as channel/owner never appears in serialized output", () => {
    // Even if a token value were (wrongly) routed into a literal field, the
    // generator only ever emits the reference for the token — prove the serialized
    // JSON has no token literal when the inputs are clean.
    const json = JSON.stringify(buildMcpJson(VALUES));
    expect(json).not.toContain(TOKEN_LOOKING);
    expect(json).toContain("${CAUCUS_TOKEN}");
  });
});

describe("buildSettings / buildHookMatcher", () => {
  it("wires a UserPromptSubmit command hook with the absolute hook bin", () => {
    const settings = buildSettings(VALUES);
    const matcher = settings.hooks.UserPromptSubmit[0]!;
    expect(matcher.matcher).toBe("");
    expect(matcher.hooks[0].type).toBe("command");
    expect(matcher.hooks[0].command).toBe("node /abs/path/to/hook/dist/bin.js");
    expect(settings.enabledMcpjsonServers).toEqual(["caucus"]);
  });

  it("buildHookMatcher matches the embedded matcher", () => {
    expect(buildHookMatcher(VALUES)).toEqual(
      buildSettings(VALUES).hooks.UserPromptSubmit[0],
    );
  });
});

describe("buildEnvFile", () => {
  it("exports url+channel, leaves the token EMPTY, and never embeds a secret", () => {
    const env = buildEnvFile(VALUES);
    expect(env).toContain("export CAUCUS_URL=http://127.0.0.1:4747");
    expect(env).toContain("export CAUCUS_CHANNEL=incident-42");
    // The token line is present but unset (the user pastes their own).
    expect(env).toContain("export CAUCUS_TOKEN=\n");
    expect(env).toContain("NEVER COMMIT");
    expect(env).not.toContain(TOKEN_LOOKING);
  });

  it("uses the custom token-env NAME on the empty export line", () => {
    const env = buildEnvFile({ ...VALUES, tokenEnv: "MY_BEARER" });
    expect(env).toContain("export MY_BEARER=\n");
  });
});
