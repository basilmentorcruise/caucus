import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import { createPrompter } from "./prompts.js";

/** Drive a prompter over in-memory streams; feed `lines` as the user's answers. */
function harness(lines: string[]): { input: PassThrough; output: PassThrough } {
  const input = new PassThrough();
  const output = new PassThrough();
  // Drain the output so the prompt writes never back-pressure readline.
  output.resume();
  // Write each answer as its own line; readline resolves question-by-question.
  for (const line of lines) input.write(line + "\n");
  return { input, output };
}

describe("createPrompter.ask", () => {
  it("returns the typed answer trimmed", async () => {
    const { input, output } = harness(["  hello  "]);
    const p = createPrompter({ input, output });
    expect(await p.ask("Q")).toBe("hello");
    p.close();
  });

  it("returns the fallback on a blank answer", async () => {
    const { input, output } = harness([""]);
    const p = createPrompter({ input, output });
    expect(await p.ask("Q", "default-val")).toBe("default-val");
    p.close();
  });

  it("returns empty string on a blank answer with no fallback", async () => {
    const { input, output } = harness([""]);
    const p = createPrompter({ input, output });
    expect(await p.ask("Q")).toBe("");
    p.close();
  });
});

describe("createPrompter.confirm", () => {
  async function confirmOnce(answer: string): Promise<boolean> {
    const { input, output } = harness([answer]);
    const p = createPrompter({ input, output });
    const result = await p.confirm("?");
    p.close();
    return result;
  }

  it("is true only for an explicit y/yes (case-insensitive)", async () => {
    expect(await confirmOnce("Y")).toBe(true);
    expect(await confirmOnce("yes")).toBe(true);
    expect(await confirmOnce("YES")).toBe(true);
    expect(await confirmOnce("n")).toBe(false);
    expect(await confirmOnce("")).toBe(false);
    expect(await confirmOnce("nope")).toBe(false);
  });
});
