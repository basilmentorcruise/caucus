import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AppendResult,
  Backbone,
  ChannelDescriptor,
  ClaimResult,
  CreateChannelOptions,
  Cursor,
  ReadResult,
} from "@caucus/backbone";
import type { MessageInput } from "@caucus/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkpointPath, readCheckpoint } from "./checkpoint.js";
import { parseHookInput, runHook } from "./run.js";

const CHANNEL = "incident-42";
const SESSION = "sess-abc";

/**
 * A fake backbone that records an in-memory log and lets a test script its
 * head / appended messages. Only the read-side methods the hook uses
 * (`subscribe`, `readSince`) are meaningful; the rest throw if hit.
 */
class FakeBackbone implements Backbone {
  log: AppendResult["message"][] = [];
  subscribeCalls = 0;
  readCalls: Array<{ cursor: Cursor }> = [];
  throwOn: "subscribe" | "readSince" | "none" = "none";
  hangOn: "subscribe" | "readSince" | "none" = "none";
  /** When set, rejections use this value verbatim (e.g. a non-Error string). */
  rejectValue: unknown = new Error("boom");

  push(...messages: AppendResult["message"][]): void {
    this.log.push(...messages);
  }

  subscribe(_channel: string): Promise<Cursor> {
    this.subscribeCalls++;
    if (this.throwOn === "subscribe") return Promise.reject(this.rejectValue);
    if (this.hangOn === "subscribe") return new Promise<Cursor>(() => {});
    return Promise.resolve(this.log.length);
  }

  readSince(_channel: string, cursor: Cursor): Promise<ReadResult> {
    this.readCalls.push({ cursor });
    if (this.throwOn === "readSince") return Promise.reject(this.rejectValue);
    if (this.hangOn === "readSince") return new Promise<ReadResult>(() => {});
    const messages = this.log.slice(cursor);
    return Promise.resolve({ messages, cursor: this.log.length });
  }

  createChannel(_opts: CreateChannelOptions): Promise<ChannelDescriptor> {
    throw new Error("not used");
  }
  describeChannel(_channel: string): Promise<ChannelDescriptor> {
    throw new Error("not used");
  }
  listChannels(): Promise<readonly ChannelDescriptor[]> {
    throw new Error("not used");
  }
  append(_channel: string, _msg: MessageInput): Promise<AppendResult> {
    throw new Error("not used");
  }
  claim(_channel: string, _msg: MessageInput): Promise<ClaimResult> {
    throw new Error("not used");
  }
}

function appended(body: string, over: Partial<AppendResult["message"]> = {}): AppendResult["message"] {
  return {
    type: "finding",
    agent_id: "alice-agent",
    owner: "alice",
    msg_id: "01J0000000000000000000000A",
    body,
    v: 0,
    ts: "t",
    ...over,
  } as AppendResult["message"];
}

let home: string;
const stderrLines: string[] = [];
const stderr = (line: string): void => {
  stderrLines.push(line);
};

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "caucus-hook-run-"));
  stderrLines.length = 0;
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function deps(backbone: Backbone, env: Record<string, string | undefined>) {
  return { backbone, env, sessionId: SESSION, home, stderr };
}

describe("parseHookInput", () => {
  it("extracts session_id from a well-formed payload", () => {
    expect(parseHookInput(JSON.stringify({ session_id: "xyz" })).sessionId).toBe("xyz");
  });

  it("falls back to 'default' for garbled stdin", () => {
    expect(parseHookInput("{not json").sessionId).toBe("default");
  });

  it("falls back to 'default' for empty stdin", () => {
    expect(parseHookInput("").sessionId).toBe("default");
  });

  it("falls back to 'default' for a missing or non-string session_id", () => {
    expect(parseHookInput(JSON.stringify({})).sessionId).toBe("default");
    expect(parseHookInput(JSON.stringify({ session_id: 5 })).sessionId).toBe("default");
    expect(parseHookInput(JSON.stringify({ session_id: "  " })).sessionId).toBe("default");
  });
});

describe("runHook — no channel configured", () => {
  it("returns empty string and touches nothing when CAUCUS_CHANNEL is unset", async () => {
    const bb = new FakeBackbone();
    const out = await runHook(deps(bb, {}));
    expect(out).toBe("");
    expect(bb.subscribeCalls).toBe(0);
    expect(bb.readCalls).toHaveLength(0);
  });
});

describe("runHook — first run mints at head, injects nothing (ADR-C6)", () => {
  it("subscribes at head, writes the checkpoint, injects nothing", async () => {
    const bb = new FakeBackbone();
    bb.push(appended("pre-existing 1"), appended("pre-existing 2"));

    const out = await runHook(deps(bb, { CAUCUS_CHANNEL: CHANNEL }));

    expect(out).toBe(""); // no history replay
    expect(bb.subscribeCalls).toBe(1);
    expect(bb.readCalls).toHaveLength(0);
    const cp = await readCheckpoint(checkpointPath(SESSION, CHANNEL, home), CHANNEL);
    expect(cp).toBe(2); // minted at head (2 pre-existing)
  });
});

describe("runHook — second run injects the delta and advances", () => {
  it("injects new messages then a no-new turn injects nothing", async () => {
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };

    // Run 1: mint at head (empty channel ⇒ cursor 0), inject nothing.
    expect(await runHook(deps(bb, env))).toBe("");

    // Two messages arrive.
    bb.push(
      appended("login accepts expired JWTs", { type: "finding" }),
      appended("on it", { type: "claim", target: "auth-timeout", agent_id: "bob-agent", owner: "bob" } as Partial<AppendResult["message"]>),
    );

    // Run 2: injects the two new messages.
    const out2 = await runHook(deps(bb, env));
    expect(out2).not.toBe("");
    const parsed = JSON.parse(out2) as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const ctx = parsed.hookSpecificOutput.additionalContext;
    expect(ctx).toContain("login accepts expired JWTs");
    expect(ctx).toContain('"auth-timeout"');
    expect(ctx).toContain("A·alice");
    expect(ctx).toContain("A·bob");

    // Checkpoint advanced to the RETURNED cursor (2).
    const cp = await readCheckpoint(checkpointPath(SESSION, CHANNEL, home), CHANNEL);
    expect(cp).toBe(2);

    // Run 3: nothing new ⇒ empty.
    expect(await runHook(deps(bb, env))).toBe("");
  });
});

describe("runHook — fail open", () => {
  it("returns empty and logs a value-free stderr line when subscribe throws", async () => {
    const bb = new FakeBackbone();
    bb.throwOn = "subscribe";
    const out = await runHook(deps(bb, { CAUCUS_CHANNEL: CHANNEL }));
    expect(out).toBe("");
    expect(stderrLines).toHaveLength(1);
    // Value-free: must not leak the channel name or a url.
    expect(stderrLines[0]).not.toContain(CHANNEL);
    expect(stderrLines[0]).not.toContain("http");
  });

  it("returns empty when readSince throws on a later turn", async () => {
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };
    await runHook(deps(bb, env)); // mint at head
    bb.throwOn = "readSince";
    const out = await runHook(deps(bb, env));
    expect(out).toBe("");
    expect(stderrLines).toHaveLength(1);
  });

  it("fails open when the backbone rejects with a non-Error value", async () => {
    const bb = new FakeBackbone();
    bb.throwOn = "subscribe";
    bb.rejectValue = "string failure"; // non-Error rejection path
    const out = await runHook(deps(bb, { CAUCUS_CHANNEL: CHANNEL }));
    expect(out).toBe("");
    expect(stderrLines).toHaveLength(1);
  });

  it("times out a hung backbone and fails open", async () => {
    const bb = new FakeBackbone();
    bb.hangOn = "subscribe"; // subscribe() never resolves
    const out = await runHook({
      ...deps(bb, { CAUCUS_CHANNEL: CHANNEL }),
      timeoutMs: 50, // a real, short client-side budget
    });
    expect(out).toBe("");
    expect(stderrLines).toHaveLength(1);
  });
});
