---
"@caucus/hook": patch
---

CAU-14: implement the Claude Code turn-start awareness hook. A `UserPromptSubmit` command hook (`caucus-hook`) reads the channel delta since a per-session checkpoint, renders new messages compactly with identity (`A·owner`, claim target, status tags; artifact URLs never surfaced — ADR-C12), advances the checkpoint, and injects them via `additionalContext`. First run mints at head and injects nothing (no backlog replay — ADR-C6); empty deltas are quiet; over-budget deltas drop the oldest lines behind a `+N older` overflow notice. Fail-open and fast (~4 s client timeout) so a slow/down backbone can't block the turn.
