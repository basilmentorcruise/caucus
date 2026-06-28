---
description: Produces a design/ADR before code, or runs the architecture-review gate after code. Use to plan a ticket/epic or to review built code for SOLID, layering, patterns, and coverage.
---

Use the `architect` subagent (its definition lives in `~/.claude/agents/architect.md`). Read `CLAUDE.md` and
`docs/sdlc/GOVERNANCE.md` for project context first. Follow the agent's Required Output Format.

Task / focus: $ARGUMENTS
If no argument is given, act on the most relevant current work for this role.
