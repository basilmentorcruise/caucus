---
description: Runs the code-review gate on a PR. Use to review a developer's PR for correctness, code smells, test quality, and docs-in-sync before it advances.
---

Use the `code-reviewer` subagent (its definition lives in `~/.claude/agents/code-reviewer.md`). Read `CLAUDE.md` and
`docs/sdlc/GOVERNANCE.md` for project context first. Follow the agent's Required Output Format.

Task / focus: $ARGUMENTS
If no argument is given, act on the most relevant current work for this role.
