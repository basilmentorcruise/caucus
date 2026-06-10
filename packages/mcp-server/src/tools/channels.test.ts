import { describe, expect, it } from "vitest";
import { InMemoryBackbone } from "@caucus/backbone";
import type { ChannelDescriptor } from "@caucus/backbone";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import {
  listChannelsTool,
  describeChannelTool,
  createChannelTool,
  joinChannelTool,
} from "./channels.js";
import { postTool } from "./post.js";
import { readChannelTool } from "./read-channel.js";
import { NotJoinedError } from "../errors.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

// Control bytes used by the CAU-73 descriptor-sanitization tests. Spelled with
// \x escapes so this source file itself stays plain printable ASCII.
const ESC = "\x1b"; // ANSI escape introducer
const BEL = "\x07"; // bell / OSC string terminator
const DEL = "\x7f"; // delete
const C1 = "\x9b"; // a C1 control byte (CSI); JSON.stringify does NOT escape it

/** Matches any C0 (\x00–\x1f), DEL (\x7f), or C1 (\x80–\x9f) control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

async function freshBackbone(): Promise<InMemoryBackbone> {
  const backbone = new InMemoryBackbone();
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "the session channel",
    created_by: "alice",
  });
  return backbone;
}

/** Parse a text tool result's JSON envelope (asserting it's not an error). */
function jsonOf<T>(
  result: Awaited<ReturnType<typeof listChannelsTool.handle>>,
): T {
  expect(result.isError).toBeFalsy();
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text) as T;
}

describe("caucus_list_channels", () => {
  it("returns count 0 and an empty list when no channels exist", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    const { count, channels } = jsonOf<{
      count: number;
      channels: ChannelDescriptor[];
    }>(await listChannelsTool.handle(session, {}));
    expect(count).toBe(0);
    expect(channels).toEqual([]);
  });

  it("reflects every existing channel with its descriptor", async () => {
    const backbone = await freshBackbone();
    await backbone.createChannel({
      channel: "incident-2",
      purpose: "second room",
      created_by: "bob",
    });
    const session = createSession(config, backbone);

    const { count, channels } = jsonOf<{
      count: number;
      channels: ChannelDescriptor[];
    }>(await listChannelsTool.handle(session, {}));
    expect(count).toBe(2);
    const names = channels.map((c) => c.channel).sort();
    expect(names).toEqual(["incident-1", "incident-2"]);
  });

  it("posts nothing — read-only (ADR-C6)", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);
    const before = (await backbone.readSince("incident-1", 0)).messages.length;
    await listChannelsTool.handle(session, {});
    const after = (await backbone.readSince("incident-1", 0)).messages.length;
    expect(after).toBe(before);
  });
});

describe("caucus_describe_channel", () => {
  it("defaults to the session channel when `channel` is omitted", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    const descriptor = jsonOf<ChannelDescriptor>(
      await describeChannelTool.handle(session, {}),
    );
    expect(descriptor.channel).toBe("incident-1");
    expect(descriptor.purpose).toBe("the session channel");
  });

  it("describes an explicitly-named other channel", async () => {
    const backbone = await freshBackbone();
    await backbone.createChannel({
      channel: "incident-2",
      purpose: "second room",
      created_by: "bob",
    });
    const session = createSession(config, backbone);

    const descriptor = jsonOf<ChannelDescriptor>(
      await describeChannelTool.handle(session, { channel: "incident-2" }),
    );
    expect(descriptor.channel).toBe("incident-2");
    expect(descriptor.created_by).toBe("bob");
  });

  it("propagates UnknownChannelError for a non-existent channel (the answer to 'does it exist?')", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    await expect(
      describeChannelTool.handle(session, { channel: "nope" }),
    ).rejects.toThrow();
  });
});

// CAU-73: list/describe JSON.stringify channel descriptors straight into the
// model context. `purpose` is caller-supplied free text (the same C1-injectable
// class as a message body) and `created_by` is a resolved owner label; both are
// poster-controlled and must be sanitized BEFORE serialization. Since CAU-71
// the backbone REJECTS dirty descriptor fields at create, so the dirty cases
// seed a stub backbone instead: the read layer must hold even if a dirty byte
// is already stored (a pre-CAU-71 store, or a future write path that skips
// validation). The raw serialized text is what reaches the other agent.
describe("CAU-73: descriptor control-character sanitization", () => {
  const dirty = `${ESC}[2J before ${BEL} ${DEL} ${C1} ${ESC}]0;pwned${BEL} after`;

  /** A hand-built descriptor as a store would return it — dirty bytes intact. */
  function dirtyDescriptor(): ChannelDescriptor {
    return {
      channel: "incident-1",
      kind: "ephemeral",
      purpose: `triage ${dirty}`,
      verbosity: "quiet",
      renderBudgetChars: 200,
      created_by: `mallory${dirty}`,
      created_ts: "2026-06-09T00:00:00.000Z#000000000001",
      head: 0,
    };
  }

  /** A session over a stub backbone that already holds a dirty descriptor. */
  function dirtyDescriptorSession(): ReturnType<typeof createSession> {
    const backbone = {
      describeChannel: () => Promise.resolve(dirtyDescriptor()),
      listChannels: () => Promise.resolve([dirtyDescriptor()]),
    } as unknown as Parameters<typeof createSession>[1];
    return createSession(config, backbone);
  }

  it("strips C0/DEL/C1 from purpose + created_by via caucus_describe_channel", async () => {
    const session = dirtyDescriptorSession();

    const result = await describeChannelTool.handle(session, {});
    const raw = (result.content[0] as { type: "text"; text: string }).text;

    // The serialized text the other agent receives contains NO control byte.
    expect(raw).not.toMatch(CONTROL_CHARS);
    expect(raw).not.toContain(C1);

    const d = JSON.parse(raw) as ChannelDescriptor;
    expect(d.purpose).toContain("triage");
    expect(d.purpose).toContain("after");
    expect(d.created_by).toContain("mallory");
  });

  it("strips C0/DEL/C1 from purpose + created_by via caucus_list_channels", async () => {
    const session = dirtyDescriptorSession();

    const result = await listChannelsTool.handle(session, {});
    const raw = (result.content[0] as { type: "text"; text: string }).text;

    expect(raw).not.toMatch(CONTROL_CHARS);
    expect(raw).not.toContain(C1);

    const { channels } = JSON.parse(raw) as { channels: ChannelDescriptor[] };
    expect(channels[0]?.purpose).toContain("triage");
    expect(channels[0]?.created_by).toContain("mallory");
  });

  it("preserves multi-line purpose structure (does NOT glue words across \\n)", async () => {
    const backbone = new InMemoryBackbone();
    await backbone.createChannel({
      channel: "incident-1",
      purpose: "line 1\nline 2",
      created_by: "alice",
    });
    const session = createSession(config, backbone);

    const result = await describeChannelTool.handle(session, {});
    const raw = (result.content[0] as { type: "text"; text: string }).text;
    const d = JSON.parse(raw) as ChannelDescriptor;
    expect(d.purpose).toBe("line 1\nline 2");
    expect(raw).not.toMatch(CONTROL_CHARS); // \n is JSON-escaped on the wire
  });

  it("does not over-strip clean unicode in purpose", async () => {
    const backbone = new InMemoryBackbone();
    await backbone.createChannel({
      channel: "incident-1",
      purpose: "↗ é café · naïve",
      created_by: "alice",
    });
    const session = createSession(config, backbone);

    const result = await describeChannelTool.handle(session, {});
    const d = JSON.parse(
      (result.content[0] as { type: "text"; text: string }).text,
    ) as ChannelDescriptor;
    expect(d.purpose).toBe("↗ é café · naïve");
  });
});

describe("caucus_create_channel", () => {
  it("creates the channel and returns its descriptor", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    const descriptor = jsonOf<ChannelDescriptor>(
      await createChannelTool.handle(session, {
        channel: "war-room",
        purpose: "checkout 500s spike",
      }),
    );
    expect(descriptor.channel).toBe("war-room");
    expect(descriptor.purpose).toBe("checkout 500s spike");
    expect(descriptor.kind).toBe("ephemeral");
  });

  it("anchors created_by to the SESSION owner — it cannot be forged via args", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    // There is no created_by argument; even smuggling one in the args object
    // (which the tool ignores) does not change attribution.
    const descriptor = jsonOf<ChannelDescriptor>(
      await createChannelTool.handle(session, {
        channel: "war-room",
        purpose: "p",
        created_by: "mallory",
      } as Record<string, unknown>),
    );
    expect(descriptor.created_by).toBe("alice");
  });

  it("propagates ChannelExistsError (value-free) on a duplicate name", async () => {
    const backbone = await freshBackbone(); // "incident-1" exists
    const session = createSession(config, backbone);

    await expect(
      createChannelTool.handle(session, {
        channel: "incident-1",
        purpose: "dup",
      }),
    ).rejects.toThrow();
  });
});

describe("caucus_join_channel", () => {
  it("verifies the room and mints a cursor at its current head", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);
    // Seed two messages so head is non-zero.
    await session.post({ type: "note", body: "one" });
    await session.post({ type: "note", body: "two" });

    const { channel, cursor, head } = jsonOf<{
      channel: string;
      cursor: number;
      head: number;
    }>(await joinChannelTool.handle(session, { channel: "incident-1" }));
    expect(channel).toBe("incident-1");
    expect(head).toBe(2);
    // join == subscribe-to-now: the cursor is the current head.
    expect(cursor).toBe(head);
  });

  it("yields a read cursor on a room OTHER than the session's posting channel", async () => {
    const backbone = await freshBackbone();
    await backbone.createChannel({
      channel: "incident-2",
      purpose: "other room",
      created_by: "bob",
    });
    const session = createSession(config, backbone);

    const { channel, cursor } = jsonOf<{ channel: string; cursor: number }>(
      await joinChannelTool.handle(session, { channel: "incident-2" }),
    );
    expect(channel).toBe("incident-2");
    expect(cursor).toBe(0);
    // The session's posting channel is unchanged — join is read-only.
    expect(session.channel).toBe("incident-1");
  });

  it("propagates UnknownChannelError when joining a non-existent room", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);

    await expect(
      joinChannelTool.handle(session, { channel: "ghost" }),
    ).rejects.toThrow();
  });

  it("posts nothing — read-only (ADR-C6)", async () => {
    const backbone = await freshBackbone();
    const session = createSession(config, backbone);
    const before = (await backbone.readSince("incident-1", 0)).messages.length;
    await joinChannelTool.handle(session, { channel: "incident-1" });
    const after = (await backbone.readSince("incident-1", 0)).messages.length;
    expect(after).toBe(before);
  });
});

describe("caucus_join_channel — CAU-92 opens the cross-room posting gate", () => {
  /** Home (`incident-1`) + a second room (`war-room-2`). */
  async function twoRoomBackbone(): Promise<InMemoryBackbone> {
    const backbone = await freshBackbone();
    await backbone.createChannel({
      channel: "war-room-2",
      purpose: "other room",
      created_by: "carol",
    });
    return backbone;
  }

  it("a join authorizes a subsequent cross-room post into that room", async () => {
    const backbone = await twoRoomBackbone();
    const session = createSession(config, backbone);

    // Before joining, a cross-room post is rejected (gate closed).
    await expect(
      postTool.handle(session, {
        type: "note",
        body: "too early",
        channel: "war-room-2",
      }),
    ).rejects.toBeInstanceOf(NotJoinedError);
    expect((await backbone.readSince("war-room-2", 0)).messages).toHaveLength(0);

    // The deliberate join opens the gate.
    await joinChannelTool.handle(session, { channel: "war-room-2" });
    await postTool.handle(session, {
      type: "note",
      body: "now allowed",
      channel: "war-room-2",
    });
    const there = await backbone.readSince("war-room-2", 0);
    expect(there.messages).toHaveLength(1);
    expect(there.messages[0]?.body).toBe("now allowed");
  });

  it("a bare caucus_read_channel({channel:X}) does NOT open the gate (only join does)", async () => {
    const backbone = await twoRoomBackbone();
    const session = createSession(config, backbone);

    // Reading X mints no posting authorization — the divergence CAU-92 pins.
    await readChannelTool.handle(session, { channel: "war-room-2" });
    await expect(
      postTool.handle(session, {
        type: "note",
        body: "read is not join",
        channel: "war-room-2",
      }),
    ).rejects.toBeInstanceOf(NotJoinedError);
    expect((await backbone.readSince("war-room-2", 0)).messages).toHaveLength(0);
  });
});
