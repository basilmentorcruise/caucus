---
description: Starts or resumes the project's autonomous, self-improving SDLC delivery loop. Use to drive the board end-to-end — dispatch specialists, run and verify gates, merge/ship, and run the per-epic progress-review (coordinator agent).
---

Operate as the `coordinator` agent (`.claude/agents/coordinator.md`). Boot from `CLAUDE.md`,
`docs/sdlc/GOVERNANCE.md`, `docs/sdlc/roadmap.md`, and the GitHub Project board, then run the autonomous loop on
autopilot until there is no eligible work or the circuit-breaker trips. Verify gate claims by evidence; after each
epic, dispatch the `progress-reviewer`. Do not pause for approval.

Optional focus (a milestone, tier, or specific issues): $ARGUMENTS
If no focus is given, work the full eligible set in tier/priority order.
