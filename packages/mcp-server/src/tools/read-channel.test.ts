import { describe, expect, it } from "vitest";
import { InMemoryBackbone, type Backbone } from "@caucus/backbone";
import type { AppendedMessage } from "@caucus/backbone";
import { newMsgId } from "@caucus/schema";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { readChannelTool } from "./read-channel.js";

// Control bytes used by the CAU-73 sanitization tests. Spelled with \x escapes
// so this source file itself stays plain printable ASCII.
const ESC = "\x1b"; // ANSI escape introducer
const BEL = "\x07"; // bell / OSC string terminator
const DEL = "\x7f"; // delete
const C1 = "\x9b"; // a C1 control byte (CSI); JSON.stringify does NOT escape it

/** Matches any C0 (\x00–\x1f), DEL (\x7f), or C1 (\x80–\x9f) control byte. */
// eslint-disable-next-line no-control-regex -- intentionally matching control bytes
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/;

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

interface ReadEnvelope {
  cursor: number;
  count: number;
  messages: AppendedMessage[];
}

function envelope(
  result: Awaited<ReturnType<typeof readChannelTool.handle>>,
): ReadEnvelope {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text);
}

async function createdSession(): Promise<{
  backbone: InMemoryBackbone;
  session: ReturnType<typeof createSession>;
}> {
  const backbone = new InMemoryBackbone();
  await backbone.createChannel({
    channel: "incident-1",
    purpose: "test",
    created_by: "alice",
  });
  return { backbone, session: createSession(config, backbone) };
}

describe("caucus_read_channel", () => {
  it("a cursor past head propagates as an error (not a silent empty page)", async () => {
    const { session } = await createdSession();
    await expect(
      readChannelTool.handle(session, { since: 99 }),
    ).rejects.toThrow(/cursor/i);
  });

  it("tolerates an as-yet-uncreated channel (empty page at cursor 0)", async () => {
    const backbone = new InMemoryBackbone();
    const session = createSession(config, backbone);

    const result = envelope(await readChannelTool.handle(session, {}));
    expect(result.cursor).toBe(0);
    expect(result.count).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("reads an empty but existing channel", async () => {
    const { session } = await createdSession();
    const result = envelope(await readChannelTool.handle(session, {}));
    expect(result.cursor).toBe(0);
    expect(result.count).toBe(0);
  });

  it("returns messages in append order with identity + type", async () => {
    const { session } = await createdSession();
    await session.post({ type: "note", body: "one" });
    await session.post({ type: "finding", body: "two" });

    const result = envelope(await readChannelTool.handle(session, {}));
    expect(result.count).toBe(2);
    expect(result.cursor).toBe(2);
    expect(result.messages.map((m) => m.body)).toEqual(["one", "two"]);
    expect(result.messages[0]?.agent_id).toBe("agent-1");
    expect(result.messages[0]?.owner).toBe("alice");
    expect(result.messages[0]?.type).toBe("note");
    expect(result.messages[1]?.type).toBe("finding");
  });

  it("AC2: since-cursor returns only what is new, then re-reading is empty", async () => {
    const { session } = await createdSession();
    await session.post({ type: "note", body: "first" });

    // Read everything so far, capture the cursor c.
    const firstRead = envelope(await readChannelTool.handle(session, {}));
    expect(firstRead.count).toBe(1);
    const c = firstRead.cursor;
    expect(c).toBe(1);

    // Two more posts after the cursor.
    await session.post({ type: "status", body: "second" });
    await session.post({ type: "status", body: "third" });

    // read(since: c) returns EXACTLY the two new messages.
    const delta = envelope(await readChannelTool.handle(session, { since: c }));
    expect(delta.count).toBe(2);
    expect(delta.messages.map((m) => m.body)).toEqual(["second", "third"]);
    expect(delta.cursor).toBe(c + 2);

    // Re-reading at the advanced cursor yields nothing.
    const tail = envelope(
      await readChannelTool.handle(session, { since: delta.cursor }),
    );
    expect(tail.count).toBe(0);
    expect(tail.cursor).toBe(c + 2);
  });

  it("caps the page with `limit`", async () => {
    const { session } = await createdSession();
    await session.post({ type: "note", body: "a" });
    await session.post({ type: "note", body: "b" });
    await session.post({ type: "note", body: "c" });

    const result = envelope(
      await readChannelTool.handle(session, { limit: 2 }),
    );
    expect(result.count).toBe(2);
    expect(result.cursor).toBe(2);
    expect(result.messages.map((m) => m.body)).toEqual(["a", "b"]);
  });

  // CAU-73: read_channel JSON.stringifies messages straight into another
  // agent's model context. A malicious poster controls every field of their own
  // message (they append with their own identity), so the untrusted string
  // fields must be sanitized BEFORE serialization. The raw serialized text is
  // what reaches the other agent, so we assert against it directly.
  describe("CAU-73: control-character sanitization", () => {
    // A dirty payload combining ANSI-ESC (\x1b[2J screen clear), BEL (\x07),
    // DEL (\x7f), a C1 byte (\x9b CSI), and an OSC sequence.
    const dirty = `${ESC}[2J before ${BEL} ${DEL} ${C1} ${ESC}]0;pwned${BEL} after`;

    it("strips C0/DEL/C1 from body, owner, and to[] in the serialized output", async () => {
      const { backbone, session } = await createdSession();
      // A malicious poster appends directly with its own (poster-controlled)
      // identity and addressing — bypassing this session's server-anchoring.
      await backbone.append("incident-1", {
        type: "finding",
        agent_id: "evil-agent",
        owner: `mallory${dirty}`,
        msg_id: newMsgId(),
        body: `finding ${dirty}`,
        to: [`bob-agent${dirty}`],
      });

      const result = await readChannelTool.handle(session, {});
      const raw = (result.content[0] as { type: "text"; text: string }).text;

      // The serialized text the other agent receives contains NO control byte.
      expect(raw).not.toMatch(CONTROL_CHARS);
      expect(raw).not.toContain(C1);

      // Printable remnants survive (only the control bytes are removed).
      const env = JSON.parse(raw) as ReadEnvelope;
      const m = env.messages[0]!;
      expect(m.body).toContain("finding");
      expect(m.body).toContain("after");
      expect(m.owner).toContain("mallory");
      expect(m.to?.[0]).toContain("bob-agent");
    });

    it("strips C1/ESC from agent_id in the serialized output", async () => {
      const { backbone, session } = await createdSession();
      // agent_id is a non-empty free-form identity string a malicious poster
      // controls (they append with their own identity). It is serialized
      // straight into another agent's context, so it must come back inert.
      await backbone.append("incident-1", {
        type: "finding",
        agent_id: `evil${C1}${ESC}[2J`,
        owner: "mallory",
        msg_id: newMsgId(),
        body: "hi",
      });

      const result = await readChannelTool.handle(session, {});
      const raw = (result.content[0] as { type: "text"; text: string }).text;

      expect(raw).not.toMatch(CONTROL_CHARS);
      expect(raw).not.toContain(C1);
      const env = JSON.parse(raw) as ReadEnvelope;
      // Printable remnants survive; the control bytes are gone.
      expect(env.messages[0]?.agent_id).toBe("evil[2J");
    });

    it("strips control chars from a claim target (the ledger key) in output", async () => {
      const { backbone, session } = await createdSession();
      await backbone.claim("incident-1", {
        type: "claim",
        agent_id: "evil-agent",
        owner: "mallory",
        msg_id: newMsgId(),
        body: "on it",
        target: `repro${dirty}`,
      });

      const result = await readChannelTool.handle(session, {});
      const raw = (result.content[0] as { type: "text"; text: string }).text;

      expect(raw).not.toMatch(CONTROL_CHARS);
      expect(raw).not.toContain(C1);
      const env = JSON.parse(raw) as ReadEnvelope;
      expect(
        (env.messages[0] as AppendedMessage & { target?: string }).target,
      ).toContain("repro");
    });

    it("strips control chars from the artifact URL in the serialized output", async () => {
      const { backbone, session } = await createdSession();
      // `artifact` is a poster-controlled field of caucus_post. read_channel
      // returns the URL (unlike the hook, which hides it behind a ↗artifact
      // marker), so it MUST be sanitized: JSON.stringify leaks C1 bytes raw.
      await backbone.append("incident-1", {
        type: "finding",
        agent_id: "evil-agent",
        owner: "mallory",
        msg_id: newMsgId(),
        body: "see artifact",
        artifact: `http://h/${C1}X${ESC}[2J`,
      });

      const result = await readChannelTool.handle(session, {});
      const raw = (result.content[0] as { type: "text"; text: string }).text;

      // No control byte survives anywhere in the serialized page.
      expect(raw).not.toMatch(CONTROL_CHARS);
      expect(raw).not.toContain(C1);
      // The URL is still returned (just sanitized) — read_channel does not hide it.
      const env = JSON.parse(raw) as ReadEnvelope;
      const m = env.messages[0] as AppendedMessage & { artifact?: string };
      expect(m.artifact).toBe("http://h/X[2J");
    });

    it("preserves multi-line body structure (does NOT glue words across \\n)", async () => {
      const { session } = await createdSession();
      await session.post({ type: "note", body: "step 1\nstep 2\tcol" });

      const result = await readChannelTool.handle(session, {});
      const raw = (result.content[0] as { type: "text"; text: string }).text;
      const env = JSON.parse(raw) as ReadEnvelope;
      // \n/\t survive: words are not glued; the model keeps the line structure.
      expect(env.messages[0]?.body).toBe("step 1\nstep 2\tcol");
      // JSON-escaped, so they are terminal-inert on the wire.
      expect(raw).toContain("step 1\\nstep 2\\tcol");
      expect(raw).not.toMatch(CONTROL_CHARS);
    });

    it("does not over-strip clean unicode", async () => {
      const { session } = await createdSession();
      await session.post({ type: "note", body: "↗ é café · naïve" });

      const result = await readChannelTool.handle(session, {});
      const raw = (result.content[0] as { type: "text"; text: string }).text;
      const env = JSON.parse(raw) as ReadEnvelope;
      expect(env.messages[0]?.body).toBe("↗ é café · naïve");
    });

    it("keeps the {cursor,count} shape unchanged after sanitization", async () => {
      const { backbone, session } = await createdSession();
      await backbone.append("incident-1", {
        type: "finding",
        agent_id: "evil-agent",
        owner: "mallory",
        msg_id: newMsgId(),
        body: `dirty ${dirty}`,
      });
      await session.post({ type: "note", body: "clean" });

      const env = envelope(await readChannelTool.handle(session, {}));
      expect(env.cursor).toBe(2);
      expect(env.count).toBe(2);
      expect(env.messages).toHaveLength(2);
    });
  });

  it("propagates an unexpected reader failure untouched", async () => {
    const boom = new Error("backbone exploded");
    const backbone = {
      readSince: () => Promise.reject(boom),
    } as unknown as Backbone;
    const session = createSession(config, backbone);

    await expect(readChannelTool.handle(session, {})).rejects.toThrow(
      "backbone exploded",
    );
  });
});
