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
