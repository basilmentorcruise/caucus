import { describe, expect, it } from "vitest";
import {
  DuplicatePostError,
  InMemoryBackbone,
  InvalidMessageError,
  MAX_BODY_CHARS,
  RateLimitedError,
} from "@caucus/backbone";
import type { AppendedMessage } from "@caucus/backbone";
import { MESSAGE_TYPES } from "@caucus/schema";
import { isUlid } from "@caucus/schema";
import type { ServerConfig } from "../config.js";
import type { CaucusSession } from "../session.js";
import { createSession } from "../session.js";
import { NotJoinedError } from "../errors.js";
import { postTool, postFindingTool, steerTool } from "./post.js";

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

// Independently spelled (NOT derived from the code under test): if the schema
// union or the tool's accepted set drifts, the lockstep test below fails loudly
// instead of silently auto-expanding.
const POST_TYPES = [
  "finding",
  "status",
  "question",
  "answer",
  "note",
  "steer",
] as const;

describe("POST_TYPES lockstep", () => {
  it("the schema union is exactly POST_TYPES plus claim", () => {
    expect([...MESSAGE_TYPES].sort()).toEqual([...POST_TYPES, "claim"].sort());
  });
});

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

  it("rejects a control-character body at write (CAU-71): invalid_message surfaces, log unchanged", async () => {
    const { backbone, session } = await freshSession();

    let thrown: unknown;
    await postTool
      .handle(session, { type: "note", body: "before\x1b[2Jafter" })
      .catch((e) => {
        thrown = e;
      });
    // The backbone's typed invalid_message error surfaces to the tool caller,
    // naming the rule but never the offending bytes (ADR-C12).
    expect(thrown).toBeInstanceOf(InvalidMessageError);
    expect((thrown as InvalidMessageError).code).toBe("invalid_message");
    expect((thrown as InvalidMessageError).issues).toContain(
      "body must not contain control characters (tab and newline are allowed)",
    );
    expect((thrown as Error).message).not.toContain("\x1b");
    // The dirty post never landed.
    expect((await readAll(backbone)).length).toBe(0);
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

  // AC1/AC2 — the agent-visible proof. The SDK turns a `handle` rejection into
  // `isError` text carrying the thrown message (see registry.ts WARNING), so what
  // we must prove here is that the message the agent sees is the actionable
  // seatbelt instruction and that it never echoes the post body (ADR-C12). We
  // drive it with a session stub whose `post` throws the seatbelt error.
  function stubSession(err: Error): CaucusSession {
    return {
      identity: { agent_id: "agent-1", owner: "alice" },
      channel: "incident-1",
      reader: {} as CaucusSession["reader"],
      noteJoined: () => undefined,
      post: () => Promise.reject(err),
      claim: () => Promise.reject(err),
      reassignClaim: () => Promise.reject(err),
      markClaimDone: () => Promise.reject(err),
      createChannel: () => Promise.reject(err),
      uploadArtifact: () => Promise.reject(err),
      fetchArtifact: () => Promise.reject(err),
    } as CaucusSession;
  }

  it("surfaces RateLimitedError's actionable message to the agent, no body (AC1)", async () => {
    const session = stubSession(new RateLimitedError(30, 12_000));
    let thrown: unknown;
    await postTool
      .handle(session, { type: "note", body: "spammy-loop-body" })
      .catch((e) => {
        thrown = e;
      });
    expect(thrown).toBeInstanceOf(RateLimitedError);
    const message = (thrown as Error).message;
    expect(message).toContain("at most 30 posts/min");
    expect(message).toContain("batch your updates");
    expect(message).not.toContain("spammy-loop-body");
  });

  it("surfaces DuplicatePostError's actionable message to the agent, no body (AC2)", async () => {
    const session = stubSession(new DuplicatePostError());
    let thrown: unknown;
    await postTool
      .handle(session, { type: "note", body: "identical-loop-body" })
      .catch((e) => {
        thrown = e;
      });
    expect(thrown).toBeInstanceOf(DuplicatePostError);
    const message = (thrown as Error).message;
    expect(message).toContain("Duplicate of your previous post");
    expect(message).toContain("Vary the content or stop repeating");
    expect(message).not.toContain("identical-loop-body");
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

describe("caucus_steer (CAU-99)", () => {
  it("fixes type=steer and anchors identity server-side (ADR-C7)", async () => {
    const { backbone, session } = await freshSession();

    const { msg_id } = envelope(
      await steerTool.handle(session, {
        body: "focus on the 14:02 deploy correlation",
      }),
    );
    expect(isUlid(msg_id)).toBe(true);

    const [msg] = await readAll(backbone);
    expect(msg?.type).toBe("steer");
    expect(msg?.body).toBe("focus on the 14:02 deploy correlation");
    // Identity is the relaying session's — "whose human steered" (ADR-C7), not a
    // free-typed field.
    expect(msg?.agent_id).toBe("agent-1");
    expect(msg?.owner).toBe("alice");
    expect(msg?.v).toBe(1);
  });

  it("carries an optional status=needs-response", async () => {
    const { backbone, session } = await freshSession();
    await steerTool.handle(session, {
      body: "hold for my call",
      status: "needs-response",
    });

    const [msg] = await readAll(backbone);
    expect(msg?.type).toBe("steer");
    expect(msg?.status).toBe("needs-response");
  });
});

describe("CAU-92 — optional channel routing arg", () => {
  /** A backbone with home + a joinable second room. */
  async function twoRoomSession(): Promise<{
    backbone: InMemoryBackbone;
    session: CaucusSession;
  }> {
    const backbone = new InMemoryBackbone();
    await backbone.createChannel({
      channel: "incident-1",
      purpose: "home",
      created_by: "alice",
    });
    await backbone.createChannel({
      channel: "war-room-2",
      purpose: "other",
      created_by: "carol",
    });
    return { backbone, session: createSession(config, backbone) };
  }

  it("schema declares an optional channel on all three post tools", () => {
    for (const tool of [postTool, postFindingTool, steerTool]) {
      // The SDK validates with this raw shape; `channel` must be present and
      // optional so today's callers (no channel) stay byte-identical.
      const shape = tool.inputSchema as Record<string, { isOptional(): boolean }>;
      expect(shape["channel"]).toBeDefined();
      expect(shape["channel"]?.isOptional()).toBe(true);
    }
  });

  it("threads channel through to the joined room (caucus_post)", async () => {
    const { backbone, session } = await twoRoomSession();
    session.noteJoined("war-room-2");

    await postTool.handle(session, {
      type: "finding",
      body: "routed cross-room",
      channel: "war-room-2",
    });

    const there = await backbone.readSince("war-room-2", 0);
    expect(there.messages).toHaveLength(1);
    expect(there.messages[0]?.body).toBe("routed cross-room");
    const home = await backbone.readSince("incident-1", 0);
    expect(home.messages).toHaveLength(0);
  });

  it("threads channel through caucus_post_finding and caucus_steer", async () => {
    const { backbone, session } = await twoRoomSession();
    session.noteJoined("war-room-2");

    await postFindingTool.handle(session, {
      body: "finding there",
      channel: "war-room-2",
    });
    await steerTool.handle(session, {
      body: "steer there",
      channel: "war-room-2",
    });

    const there = await backbone.readSince("war-room-2", 0);
    expect(there.messages.map((m) => m.body)).toEqual([
      "finding there",
      "steer there",
    ]);
  });

  it("does NOT store channel as message content (routing only)", async () => {
    const { backbone, session } = await twoRoomSession();
    session.noteJoined("war-room-2");
    await postTool.handle(session, {
      type: "note",
      body: "routing-not-content",
      channel: "war-room-2",
    });
    const there = await backbone.readSince("war-room-2", 0);
    const stored = there.messages[0] as AppendedMessage;
    expect("channel" in stored).toBe(false);
  });

  it("NotJoinedError surfaces a value-free SDK error (channel/body absent — ADR-C12)", async () => {
    const { backbone, session } = await twoRoomSession();
    // Deliberately NOT joined.
    let thrown: unknown;
    await postTool
      .handle(session, {
        type: "finding",
        body: "leak-me-body",
        channel: "war-room-2",
      })
      .catch((e) => {
        thrown = e;
      });
    expect(thrown).toBeInstanceOf(NotJoinedError);
    const message = (thrown as Error).message;
    expect(message).not.toContain("war-room-2");
    expect(message).not.toContain("leak-me-body");
    // The gate fired before the backbone — nothing landed in the target.
    const there = await backbone.readSince("war-room-2", 0);
    expect(there.messages).toHaveLength(0);
  });
});
