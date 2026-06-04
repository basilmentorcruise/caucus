import { describe, expect, it } from "vitest";
import { InMemoryBackbone, type Backbone } from "@caucus/backbone";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { statusTool } from "./status.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

function reportFrom(result: Awaited<ReturnType<typeof statusTool.handle>>): {
  agent_id: string;
  owner: string;
  channel: string;
  head: number | null;
} {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text);
}

describe("caucus_status", () => {
  it("reports the session identity and channel", async () => {
    const backbone = new InMemoryBackbone();
    await backbone.createChannel({
      channel: "incident-1",
      purpose: "test",
      created_by: "alice",
    });
    const session = createSession(config, backbone);

    const report = reportFrom(await statusTool.handle(session, {}));
    expect(report.agent_id).toBe("agent-1");
    expect(report.owner).toBe("alice");
    expect(report.channel).toBe("incident-1");
    expect(report.head).toBe(0);
  });

  it("tolerates an as-yet-uncreated channel (head: null)", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    const report = reportFrom(await statusTool.handle(session, {}));
    expect(report.channel).toBe("incident-1");
    expect(report.head).toBeNull();
  });

  it("reflects the current head after appends", async () => {
    const backbone = new InMemoryBackbone();
    await backbone.createChannel({
      channel: "incident-1",
      purpose: "test",
      created_by: "alice",
    });
    const session = createSession(config, backbone);
    await session.post({ type: "note", body: "one" });

    const report = reportFrom(await statusTool.handle(session, {}));
    expect(report.head).toBe(1);
  });

  it("posts NOTHING — the log length is unchanged (ADR-C6)", async () => {
    const backbone = new InMemoryBackbone();
    await backbone.createChannel({
      channel: "incident-1",
      purpose: "test",
      created_by: "alice",
    });
    const session = createSession(config, backbone);

    const before = (await backbone.readSince("incident-1", 0)).messages.length;
    await statusTool.handle(session, {});
    const after = (await backbone.readSince("incident-1", 0)).messages.length;
    expect(after).toBe(before);
  });

  it("propagates an unexpected describeChannel failure", async () => {
    const boom = new Error("backbone exploded");
    const backbone = {
      describeChannel: () => Promise.reject(boom),
    } as unknown as Backbone;
    const session = createSession(config, backbone);

    await expect(statusTool.handle(session, {})).rejects.toThrow(
      "backbone exploded",
    );
  });

  it("exposes no token or secret (ADR-C12)", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);
    const result = await statusTool.handle(session, {});
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/secret/i);
  });
});
