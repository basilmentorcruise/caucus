---
description: Audits the repo and re-plans the backlog into milestone-ordered tickets with a pinned handoff brief. Use before a coordinator loop, after a big merge wave, or when the backlog drifted.
---

Use the `preplanner` subagent (its definition lives in `~/.claude/agents/preplanner.md`). Read `CLAUDE.md` and
`docs/sdlc/GOVERNANCE.md` for project context first. Follow the agent's Required Output Format.

Task / focus: $ARGUMENTS
If no argument is given, act on the most relevant current work for this role.
