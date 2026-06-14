/**
 * Zero-dependency interactive prompts for `caucus init` (CAU-108).
 *
 * Hand-rolled over `node:readline` to keep the published tarball lean (no new
 * runtime deps). Prompting is SKIPPED entirely under `--yes` or on a non-TTY
 * (CI, piped stdin); the orchestrator checks `process.stdin.isTTY` before
 * constructing these. Diagnostic prompts go to stderr so stdout stays clean.
 */
import { createInterface, type Interface } from "node:readline";

/** Streams a prompt session reads/writes (injected for testability). */
export interface PromptIo {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

/**
 * A bound prompter over one readline interface. Close it when done (the
 * orchestrator does this in a `finally`).
 */
export interface Prompter {
  /** Ask a question; returns the trimmed answer, or `fallback` if the answer is blank. */
  ask(question: string, fallback?: string): Promise<string>;
  /** Ask a yes/no question; returns true only on an explicit y/yes (default no). */
  confirm(question: string): Promise<boolean>;
  /** Release the underlying readline interface. */
  close(): void;
}

/** Create a {@link Prompter} over the given IO (defaults to stdin/stderr). */
export function createPrompter(io?: PromptIo): Prompter {
  const input = io?.input ?? process.stdin;
  const output = io?.output ?? process.stderr;
  const rl: Interface = createInterface({ input, output });
  const question = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));
  return {
    async ask(q, fallback) {
      const suffix = fallback !== undefined && fallback !== "" ? ` [${fallback}]` : "";
      const answer = (await question(`${q}${suffix}: `)).trim();
      return answer === "" ? (fallback ?? "") : answer;
    },
    async confirm(q) {
      const answer = (await question(`${q} [y/N]: `)).trim().toLowerCase();
      return answer === "y" || answer === "yes";
    },
    close() {
      rl.close();
    },
  };
}
