import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppendResult,
  type Backbone,
  type ChannelDescriptor,
  type ClaimResult,
  type CreateChannelOptions,
  type Cursor,
  InMemoryBackbone,
  InvalidCursorError,
  type ReadResult,
  UnknownChannelError,
} from "@caucus/backbone";
import { newMsgId, type MessageInput } from "@caucus/schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkpointPath, readCheckpoint, writeCheckpoint } from "./checkpoint.js";
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
  /**
   * A queue of values to reject the NEXT readSince call(s) with, one per call,
   * then fall through to the normal log slice. Models an ephemeral restart: the
   * stale-cursor read rejects once, the re-minted next read succeeds.
   */
  readSinceRejectQueue: unknown[] = [];

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
    if (this.readSinceRejectQueue.length > 0) {
      return Promise.reject(this.readSinceRejectQueue.shift());
    }
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

describe("runHook — self-heals a stale checkpoint after an ephemeral restart (CAU-72)", () => {
  it("re-mints when readSince throws invalid_cursor, injects nothing, then resumes next run", async () => {
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };
    const path = checkpointPath(SESSION, CHANNEL, home);

    // A stale on-disk checkpoint of 5 survives a restart that reset head to 0
    // (the fake's log is empty ⇒ subscribe() returns 0).
    await writeCheckpoint(path, 5, CHANNEL);
    // The first readSince (cursor 5 > head 0) rejects with the real backbone
    // out-of-range error; the re-minted read on the NEXT run succeeds normally.
    bb.readSinceRejectQueue.push(
      new InvalidCursorError("cursor must be an integer in [0, 0]", 5),
    );

    // Run 1: the stale read throws ⇒ self-heal. Inject nothing this turn.
    const out1 = await runHook(deps(bb, env));
    expect(out1).toBe("");
    expect(bb.readCalls).toEqual([{ cursor: 5 }]); // tried the stale cursor
    expect(bb.subscribeCalls).toBe(1); // re-minted at the fresh head

    // Checkpoint re-minted to the fresh head (0), NOT the stale 5.
    expect(await readCheckpoint(path, CHANNEL)).toBe(0);

    // A value-free diagnostic — never the channel name or a url (ADR-C12).
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).not.toContain(CHANNEL);
    expect(stderrLines[0]).not.toContain("http");

    // New messages arrive after the restart.
    bb.push(appended("fresh after restart 1"), appended("fresh after restart 2"));

    // Run 2: the session is no longer blind — it injects the fresh delta from
    // the re-minted cursor (0), proving recovery.
    const out2 = await runHook(deps(bb, env));
    expect(out2).not.toBe("");
    const ctx = (
      JSON.parse(out2) as {
        hookSpecificOutput: { additionalContext: string };
      }
    ).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("fresh after restart 1");
    expect(ctx).toContain("fresh after restart 2");
    expect(await readCheckpoint(path, CHANNEL)).toBe(2);
  });

  it("re-mints on an unknown_channel error (fresh backbone never recreated the channel)", async () => {
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };
    const path = checkpointPath(SESSION, CHANNEL, home);

    await writeCheckpoint(path, 12, CHANNEL);
    bb.readSinceRejectQueue.push(new UnknownChannelError(CHANNEL));

    const out = await runHook(deps(bb, env));
    expect(out).toBe(""); // inject nothing this turn
    expect(bb.subscribeCalls).toBe(1); // re-minted
    expect(await readCheckpoint(path, CHANNEL)).toBe(0); // healed to fresh head
    expect(stderrLines).toHaveLength(1);
  });

  it("does NOT modify a valid checkpoint on a transient (connection-refused) error", async () => {
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };
    const path = checkpointPath(SESSION, CHANNEL, home);

    // A genuine, in-range checkpoint and a transient fault (a non-out-of-range
    // Error — e.g. ECONNREFUSED surfaces as a plain Error, not a BackboneError).
    await writeCheckpoint(path, 3, CHANNEL);
    bb.readSinceRejectQueue.push(new Error("connect ECONNREFUSED 127.0.0.1:5050"));

    const out = await runHook(deps(bb, env));
    expect(out).toBe(""); // fail open: inject nothing
    // The checkpoint is UNTOUCHED — we don't clobber it for a brief outage.
    expect(await readCheckpoint(path, CHANNEL)).toBe(3);
    // No re-mint subscribe was attempted (pure no-op fail-open).
    expect(bb.subscribeCalls).toBe(0);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).not.toContain(CHANNEL);
  });

  it("does NOT modify a valid checkpoint on a transient timeout (hung readSince)", async () => {
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };
    const path = checkpointPath(SESSION, CHANNEL, home);

    await writeCheckpoint(path, 7, CHANNEL);
    bb.hangOn = "readSince"; // never resolves ⇒ the client-side timeout fires

    const out = await runHook({ ...deps(bb, env), timeoutMs: 50 });
    expect(out).toBe("");
    expect(await readCheckpoint(path, CHANNEL)).toBe(7); // untouched
    expect(bb.subscribeCalls).toBe(0); // no re-mint on a transient timeout
    expect(stderrLines).toHaveLength(1);
  });

  it("self-heals on an Error carrying .code = invalid_cursor that is NOT our class (foreign client)", async () => {
    // A backbone client from a different build/realm surfaces an Error that
    // carries the stable `.code` but fails `instanceof InvalidCursorError`
    // (cross-realm, or a generic BackboneError the wire reconstructs for an
    // unmodeled code). We branch on the wire-stable `.code`, not just the class.
    const foreign = Object.assign(new Error("cursor must be in [0, 0]"), {
      code: "invalid_cursor",
    });
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };
    const path = checkpointPath(SESSION, CHANNEL, home);

    await writeCheckpoint(path, 9, CHANNEL);
    bb.readSinceRejectQueue.push(foreign);
    expect(foreign instanceof InvalidCursorError).toBe(false); // sanity

    const out = await runHook(deps(bb, env));
    expect(out).toBe("");
    expect(bb.subscribeCalls).toBe(1); // re-minted via .code discrimination
    expect(await readCheckpoint(path, CHANNEL)).toBe(0);
  });

  it("does NOT self-heal an Error with an unrelated .code (treated as transient)", async () => {
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };
    const path = checkpointPath(SESSION, CHANNEL, home);

    await writeCheckpoint(path, 4, CHANNEL);
    bb.readSinceRejectQueue.push(
      Object.assign(new Error("slow down"), { code: "rate_limited" }),
    );

    const out = await runHook(deps(bb, env));
    expect(out).toBe("");
    expect(bb.subscribeCalls).toBe(0); // no re-mint
    expect(await readCheckpoint(path, CHANNEL)).toBe(4); // untouched
  });

  it("stays fail-open and value-free when the re-mint itself fails (subscribe throws)", async () => {
    const bb = new FakeBackbone();
    const env = { CAUCUS_CHANNEL: CHANNEL };
    const path = checkpointPath(SESSION, CHANNEL, home);

    await writeCheckpoint(path, 5, CHANNEL);
    // Stale read triggers a re-mint, but the backbone has now gone down so the
    // subscribe() re-mint also fails. We must still fail open, not throw.
    bb.readSinceRejectQueue.push(new InvalidCursorError("out of range", 5));
    bb.throwOn = "subscribe";

    const out = await runHook(deps(bb, env));
    expect(out).toBe(""); // fail open
    expect(bb.subscribeCalls).toBe(1); // attempted the re-mint
    // The re-mint never persisted, so the stale checkpoint is left as-is to be
    // re-attempted next turn (NOT silently advanced).
    expect(await readCheckpoint(path, CHANNEL)).toBe(5);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).not.toContain(CHANNEL);
    expect(stderrLines[0]).not.toContain("http");
  });
});

describe("runHook — pages a clamped backlog across turns (CAU-83)", () => {
  it("drains a 5-message backlog over three turns at maxReadLimit 2, then injects nothing", async () => {
    // A REAL backbone with a tiny read page cap: the hook reads ONE page per
    // turn (deliberately no drain loop — turn-time + context budget) and
    // converges on head across turns via the persisted returned cursor.
    const bb = new InMemoryBackbone({ maxReadLimit: 2 });
    await bb.createChannel({
      channel: CHANNEL,
      purpose: "paging",
      created_by: "alice",
    });
    const env = { CAUCUS_CHANNEL: CHANNEL };
    const path = checkpointPath(SESSION, CHANNEL, home);

    // Mint the checkpoint at head 0, then a 5-message backlog arrives.
    expect(await runHook(deps(bb, env))).toBe("");
    const bodies = ["page-a", "page-b", "page-c", "page-d", "page-e"];
    for (const body of bodies) {
      await bb.append(CHANNEL, {
        type: "finding",
        agent_id: "alice-agent",
        owner: "alice",
        msg_id: newMsgId(),
        body,
      });
    }

    // Three turns, each injecting one non-empty page; the union covers all 5
    // bodies with no repeats across turns (2 + 2 + 1).
    const expectPage = async (expected: string[]): Promise<void> => {
      const out = await runHook(deps(bb, env));
      expect(out).not.toBe("");
      const ctx = (
        JSON.parse(out) as {
          hookSpecificOutput: { additionalContext: string };
        }
      ).hookSpecificOutput.additionalContext;
      for (const body of bodies) {
        if (expected.includes(body)) {
          expect(ctx).toContain(body);
        } else {
          expect(ctx).not.toContain(body);
        }
      }
    };
    await expectPage(["page-a", "page-b"]);
    await expectPage(["page-c", "page-d"]);
    await expectPage(["page-e"]);

    // Converged: the checkpoint sits at head after turn 3…
    expect(await readCheckpoint(path, CHANNEL)).toBe(await bb.subscribe(CHANNEL));
    // …so the fourth turn injects nothing.
    expect(await runHook(deps(bb, env))).toBe("");
  });
});
