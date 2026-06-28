---
description: Runs the ship-readiness gate (SHIP/HOLD/BLOCKED) or cuts an epic release. Use as the last gate before merge, or to cut a tagged release with a changelog.
---

Use the `release-coordinator` subagent (its definition lives in `~/.claude/agents/release-coordinator.md`). Read `CLAUDE.md` and
`docs/sdlc/GOVERNANCE.md` for project context first. Follow the agent's Required Output Format.

Task / focus: $ARGUMENTS
If no argument is given, act on the most relevant current work for this role.
