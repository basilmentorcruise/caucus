import { describe, expect, it } from "vitest";
import { InMemoryBackbone, MAX_BODY_CHARS } from "@caucus/backbone";
import type { AppendedMessage } from "@caucus/backbone";
import { MESSAGE_TYPES } from "@caucus/schema";
import { isUlid } from "@caucus/schema";
import type { ServerConfig } from "../config.js";
import { createSession } from "../session.js";
import { postTool, postFindingTool } from "./post.js";

const config: ServerConfig = {
  identity: { agent_id: "agent-1", owner: "alice" },
  channel: "incident-1",
};

/** Build a session over a fresh, created channel. */
async function freshSession(): Promise<{
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

/** Parse the JSON `{ msg_id, cursor }` envelope a post tool returns. */
function envelope(
  result: Awaited<ReturnType<typeof postTool.handle>>,
): { msg_id: string; cursor: number } {
  const first = result.content[0];
  expect(first?.type).toBe("text");
  return JSON.parse((first as { type: "text"; text: string }).text);
}

/** Read the full log back. */
async function readAll(
  backbone: InMemoryBackbone,
): Promise<readonly AppendedMessage[]> {
  const { messages } = await backbone.readSince("incident-1", 0);
  return messages;
}

const POST_TYPES = MESSAGE_TYPES.filter((t) => t !== "claim");

describe("caucus_post", () => {
  it.each(POST_TYPES)("posts a %s message, stamped + ULID msg_id", async (type) => {
    const { backbone, session } = await freshSession();

    const { msg_id, cursor } = envelope(
      await postTool.handle(session, { type, body: `a ${type}` }),
    );
    expect(isUlid(msg_id)).toBe(true);
    expect(cursor).toBe(1);

    const [msg] = await readAll(backbone);
    expect(msg?.type).toBe(type);
    expect(msg?.body).toBe(`a ${type}`);
    expect(msg?.agent_id).toBe("agent-1");
    expect(msg?.owner).toBe("alice");
    expect(msg?.msg_id).toBe(msg_id);
  });

  it("passes optional fields through when present", async () => {
    const { backbone, session } = await freshSession();
    await postTool.handle(session, {
      type: "answer",
      body: "resolved it",
      thread: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      reply_to: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      to: ["agent-2"],
      artifact: "https://example.com/log",
      status: "resolved",
    });

    const [msg] = await readAll(backbone);
    expect(msg?.thread).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(msg?.reply_to).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAW");
    expect(msg?.to).toEqual(["agent-2"]);
    expect(msg?.artifact).toBe("https://example.com/log");
    expect(msg?.status).toBe("resolved");
  });

  it("omits absent optional fields (no undefined keys on the stored message)", async () => {
    const { backbone, session } = await freshSession();
    await postTool.handle(session, { type: "note", body: "minimal" });

    const [msg] = await readAll(backbone);
    expect(msg).toBeDefined();
    const stored = msg as AppendedMessage;
    expect("thread" in stored).toBe(false);
    expect("reply_to" in stored).toBe(false);
    expect("to" in stored).toBe(false);
    expect("artifact" in stored).toBe(false);
    expect("status" in stored).toBe(false);
  });

  it("rejects an over-cap body WITHOUT echoing the body (ADR-C12)", async () => {
    const { session } = await freshSession();
    const huge = "x".repeat(MAX_BODY_CHARS + 1);

    let thrown: unknown;
    await postTool.handle(session, { type: "note", body: huge }).catch((e) => {
      thrown = e;
    });
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The error states the limit, never the offending content.
    expect(message).not.toContain(huge);
    expect(message).not.toContain("xxxxxxxxxx");
  });
});

describe("caucus_post_finding", () => {
  it("fixes type=finding and stamps identity + ULID", async () => {
    const { backbone, session } = await freshSession();

    const { msg_id } = envelope(
      await postFindingTool.handle(session, { body: "JWTs not re-checked" }),
    );
    expect(isUlid(msg_id)).toBe(true);

    const [msg] = await readAll(backbone);
    expect(msg?.type).toBe("finding");
    expect(msg?.body).toBe("JWTs not re-checked");
    expect(msg?.agent_id).toBe("agent-1");
    expect(msg?.owner).toBe("alice");
  });

  it("passes its optional fields through", async () => {
    const { backbone, session } = await freshSession();
    await postFindingTool.handle(session, {
      body: "see the repro",
      thread: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      to: ["agent-2"],
      artifact: "https://example.com/repro",
    });

    const [msg] = await readAll(backbone);
    expect(msg?.thread).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(msg?.to).toEqual(["agent-2"]);
    expect(msg?.artifact).toBe("https://example.com/repro");
  });
});
