---
description: Runs the per-ticket QA gate or the real-app epic end-to-end. Use to validate a ticket before merge, or to run an epic's full E2E human-simulation.
---

Use the `qa` subagent (its definition lives in `~/.claude/agents/qa.md`). Read `CLAUDE.md` and
`docs/sdlc/GOVERNANCE.md` for project context first. Follow the agent's Required Output Format.

Task / focus: $ARGUMENTS
If no argument is given, act on the most relevant current work for this role.
