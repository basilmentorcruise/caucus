---
description: Threat-models an epic before code, or runs the security gate on a PR. Use for OWASP/ASVS, secret/PII, and vulnerable-dependency review.
---

Use the `security` subagent (its definition lives in `~/.claude/agents/security.md`). Read `CLAUDE.md` and
`docs/sdlc/GOVERNANCE.md` for project context first. Follow the agent's Required Output Format.

Task / focus: $ARGUMENTS
If no argument is given, act on the most relevant current work for this role.
