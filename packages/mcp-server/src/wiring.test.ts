/**
 * Unit tests for {@link selectBackbone} (CAU-50, AC1).
 *
 * The entrypoint's backbone selection is pure w.r.t. its `env` argument, so the
 * mode switch is testable without a process or a live server: `CAUCUS_URL` set
 * ⇒ an `HttpBackbone` carrying `CAUCUS_TOKEN` as its bearer; unset ⇒ a
 * process-local `InMemoryBackbone` fallback.
 *
 * We assert the CONSTRUCTED TYPE (the AC) plus the two behaviors that matter for
 * the demo to work: the HTTP client targets the configured URL, and it forwards
 * the token as the `Authorization: Bearer` header on a write. `selectBackbone`
 * takes no `fetch` override, so the URL/bearer check stubs the global `fetch` for
 * the duration of one call on the returned backbone. The full end-to-end proof
 * (two real MCP processes + the hook over a live server) lives in the
 * `shared-backbone` integration scenario.
 */
import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import { HttpBackbone } from "@caucus/backbone-server";
import { ConfigError } from "./config.js";
import { selectBackbone } from "./wiring.js";

describe("selectBackbone (CAU-50 AC1 — CAUCUS_URL switches the backbone)", () => {
  it("CAUCUS_URL set ⇒ an HttpBackbone (not the in-memory fallback)", () => {
    const backbone = selectBackbone({
      CAUCUS_URL: "http://127.0.0.1:4317",
      CAUCUS_TOKEN: "tok-alice-secret",
    });
    expect(backbone).toBeInstanceOf(HttpBackbone);
    expect(backbone).not.toBeInstanceOf(InMemoryBackbone);
  });

  it("CAUCUS_URL set without a token still yields an HttpBackbone", () => {
    // config.ts requires CAUCUS_TOKEN, so this combination is rejected upstream
    // at loadConfig — but selectBackbone itself must not depend on the token's
    // presence (it only forwards it as the bearer). An absent token ⇒ no header.
    const backbone = selectBackbone({ CAUCUS_URL: "http://127.0.0.1:4317" });
    expect(backbone).toBeInstanceOf(HttpBackbone);
  });

  it("CAUCUS_URL unset ⇒ a process-local InMemoryBackbone (offline fallback)", () => {
    const backbone = selectBackbone({ CAUCUS_TOKEN: "agent:owner" });
    expect(backbone).toBeInstanceOf(InMemoryBackbone);
    expect(backbone).not.toBeInstanceOf(HttpBackbone);
  });

  it("an all-whitespace CAUCUS_URL counts as unset (offline fallback)", () => {
    const backbone = selectBackbone({ CAUCUS_URL: "   " });
    expect(backbone).toBeInstanceOf(InMemoryBackbone);
  });

  it("the HttpBackbone targets the configured URL and forwards the bearer", async () => {
    // Prove the URL and bearer are wired through by exercising the RETURNED
    // backbone against a stub `fetch`. selectBackbone takes no fetch override, so
    // we stub the global fetch for the duration of one call. createChannel is a
    // write, so the bearer must ride along as `Authorization: Bearer <token>`.
    const calls: { url: string; auth: string | null }[] = [];
    const realFetch = globalThis.fetch;
    const stub: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(input),
        auth: headers.get("authorization"),
      });
      return Promise.resolve(
        new Response(
          JSON.stringify({ channel: "c", purpose: "p", created_by: "alice", head: 0 }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    };
    globalThis.fetch = stub;
    try {
      const backbone = selectBackbone({
        CAUCUS_URL: "http://127.0.0.1:5599",
        CAUCUS_TOKEN: "tok-alice-secret",
      });
      await backbone.createChannel({ channel: "c", purpose: "p", created_by: "alice" });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:5599/channels");
    expect(calls[0]?.auth).toBe("Bearer tok-alice-secret");
  });
});

describe("selectBackbone (CAU-75 — CAUCUS_URL scheme validation)", () => {
  it("a non-http(s) scheme → ConfigError (ftp:, file:)", () => {
    expect(() => selectBackbone({ CAUCUS_URL: "ftp://x" })).toThrow(ConfigError);
    expect(() => selectBackbone({ CAUCUS_URL: "ftp://x" })).toThrow(
      "CAUCUS_URL must use http: or https:",
    );
    expect(() => selectBackbone({ CAUCUS_URL: "file:///x" })).toThrow(ConfigError);
  });

  it("a userinfo-bearing http URL → ConfigError (credentials never reach undici)", () => {
    // A PARSABLE URL with embedded credentials passes the scheme check, so it
    // would otherwise reach HttpBackbone — and undici rejects userinfo URLs at
    // request time with a TypeError that echoes the FULL URL (password
    // included) into the MCP tool-call context. It must be rejected here, with
    // a message that names neither the URL nor the password (ADR-C12).
    const env = { CAUCUS_URL: "http://user:hunter2@127.0.0.1:4747" };
    expect(() => selectBackbone(env)).toThrow(ConfigError);
    expect(() => selectBackbone(env)).toThrow(
      "CAUCUS_URL must not contain credentials (userinfo)",
    );
    let thrown: unknown;
    try {
      selectBackbone(env);
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).not.toContain("hunter2");
    // A bare username (no password) is userinfo too.
    expect(() => selectBackbone({ CAUCUS_URL: "http://user@127.0.0.1:4747" })).toThrow(
      ConfigError,
    );
  });

  it("an unparsable URL → ConfigError", () => {
    expect(() => selectBackbone({ CAUCUS_URL: "not a url" })).toThrow(ConfigError);
    expect(() => selectBackbone({ CAUCUS_URL: "not a url" })).toThrow(
      "CAUCUS_URL is not a valid URL",
    );
    expect(() => selectBackbone({ CAUCUS_URL: ":::" })).toThrow(ConfigError);
  });

  it("http: and https: URLs still yield an HttpBackbone", () => {
    expect(selectBackbone({ CAUCUS_URL: "http://127.0.0.1:4317" })).toBeInstanceOf(
      HttpBackbone,
    );
    expect(selectBackbone({ CAUCUS_URL: "https://caucus.example.com" })).toBeInstanceOf(
      HttpBackbone,
    );
  });

  it("HYGIENE: the error never echoes the URL value or the token (ADR-C12)", () => {
    // A bad URL carrying userinfo credentials, alongside a real-looking token.
    // String(err) goes to stderr, so neither secret may appear in the message.
    let thrown: unknown;
    try {
      selectBackbone({
        CAUCUS_URL: "http://user:hunter2@nope^",
        CAUCUS_TOKEN: "tok-secret",
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = String(thrown);
    expect(message).not.toContain("tok-secret");
    expect(message).not.toContain("hunter2");
  });

  it("HYGIENE: a token pasted as CAUCUS_URL never echoes in the scheme error (ADR-C12)", () => {
    // `new URL("tok-secret-scheme:4747")` PARSES — the token segment becomes
    // the protocol ("tok-secret-scheme:") — so a scheme error that named the
    // protocol would leak the pasted token verbatim to stderr.
    let thrown: unknown;
    try {
      selectBackbone({ CAUCUS_URL: "tok-secret-scheme:4747" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    expect(String(thrown)).not.toContain("tok-secret-scheme");
  });
});
