import { describe, expect, it } from "vitest";
import {
  ChannelExistsError,
  InMemoryBackbone,
  UnknownChannelError,
  type Backbone,
  type ChannelDescriptor,
  type CreateChannelOptions,
} from "@caucus/backbone";
import type { ServerConfig } from "./config.js";
import { ensureChannel } from "./bootstrap.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

describe("ensureChannel (CAU-12 startup bootstrap)", () => {
  it("creates the session channel when it is missing, attributed to the owner", async () => {
    const backbone = new InMemoryBackbone();

    const descriptor = await ensureChannel(backbone, config);
    expect(descriptor.channel).toBe("incident-1");
    expect(descriptor.created_by).toBe("alice");

    // The channel is now usable: a write no longer fails with unknown_channel
    // — the exact end-to-end gap this bootstrap closes (CAU-10 validation).
    const described = await backbone.describeChannel("incident-1");
    expect(described.channel).toBe("incident-1");
  });

  it("is a no-op when the channel already exists (idempotent, never re-creates)", async () => {
    const backbone = new InMemoryBackbone();
    const created = await backbone.createChannel({
      channel: "incident-1",
      purpose: "human-created room",
      created_by: "bob",
    });

    const descriptor = await ensureChannel(backbone, config);
    // Returns the EXISTING descriptor untouched — purpose/owner are not
    // overwritten with the auto-create defaults.
    expect(descriptor.purpose).toBe("human-created room");
    expect(descriptor.created_by).toBe("bob");
    expect(descriptor.created_ts).toBe(created.created_ts);

    // Calling again is still a no-op (no ChannelExistsError thrown).
    await expect(ensureChannel(backbone, config)).resolves.toBeDefined();
    expect(await backbone.listChannels()).toHaveLength(1);
  });

  it("propagates a non-unknown-channel error (e.g. a malformed channel slug)", async () => {
    // A backbone whose describeChannel rejects with something OTHER than
    // UnknownChannelError must NOT be masked by a create attempt — a real
    // misconfiguration has to surface at startup.
    const boom = new Error("backbone exploded");
    const stub: Pick<Backbone, "describeChannel" | "createChannel"> = {
      describeChannel(): Promise<ChannelDescriptor> {
        return Promise.reject(boom);
      },
      createChannel(_opts: CreateChannelOptions): Promise<ChannelDescriptor> {
        throw new Error("createChannel must not be called");
      },
    };

    await expect(
      ensureChannel(stub as Backbone, config),
    ).rejects.toThrow("backbone exploded");
  });

  it("creates only when describeChannel signals a genuinely-missing channel", async () => {
    // Sanity: an UnknownChannelError specifically routes to create.
    let described = false;
    let created = false;
    const stub: Pick<Backbone, "describeChannel" | "createChannel"> = {
      describeChannel(): Promise<ChannelDescriptor> {
        described = true;
        return Promise.reject(new UnknownChannelError("incident-1"));
      },
      createChannel(opts: CreateChannelOptions): Promise<ChannelDescriptor> {
        created = true;
        return Promise.resolve({
          channel: opts.channel,
          kind: "ephemeral",
          purpose: opts.purpose,
          verbosity: "quiet",
          renderBudgetChars: 200,
          created_by: opts.created_by,
          created_ts: "2026-06-04T00:00:00.000Z",
          head: 0,
        });
      },
    };

    const descriptor = await ensureChannel(stub as Backbone, config);
    expect(described).toBe(true);
    expect(created).toBe(true);
    expect(descriptor.created_by).toBe("alice");
    expect(descriptor.purpose).toContain("auto-created");
  });

  it("tolerates losing the describe-then-create race (ChannelExistsError ⇒ success)", async () => {
    // Two sessions booting concurrently against a SHARED backbone (CAU-50)
    // can both see "missing" and race the create. The loser must treat the
    // now-existing channel as success, not crash at startup.
    let describeCalls = 0;
    const existing: ChannelDescriptor = {
      channel: "incident-1",
      kind: "ephemeral",
      purpose: "created by the race winner",
      verbosity: "quiet",
      renderBudgetChars: 200,
      created_by: "bob",
      created_ts: "2026-06-04T00:00:00.000Z",
      head: 0,
    };
    const stub: Pick<Backbone, "describeChannel" | "createChannel"> = {
      describeChannel(): Promise<ChannelDescriptor> {
        describeCalls += 1;
        // First describe: missing (pre-race). Second: the winner created it.
        return describeCalls === 1
          ? Promise.reject(new UnknownChannelError("incident-1"))
          : Promise.resolve(existing);
      },
      createChannel(): Promise<ChannelDescriptor> {
        return Promise.reject(new ChannelExistsError("incident-1"));
      },
    };

    const descriptor = await ensureChannel(stub as Backbone, config);
    expect(describeCalls).toBe(2);
    expect(descriptor).toEqual(existing);
  });

  it("a non-exists create failure still propagates", async () => {
    const stub: Pick<Backbone, "describeChannel" | "createChannel"> = {
      describeChannel(): Promise<ChannelDescriptor> {
        return Promise.reject(new UnknownChannelError("incident-1"));
      },
      createChannel(): Promise<ChannelDescriptor> {
        return Promise.reject(new Error("create exploded"));
      },
    };
    await expect(ensureChannel(stub as Backbone, config)).rejects.toThrow(
      "create exploded",
    );
  });
});
