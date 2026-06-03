# GitHub Projects & SDLC Playbook

How Caucus runs its software development lifecycle on GitHub. **Tickets live only on the GitHub Project board — never in this repo.** Markdown in `docs/` is for durable context (vision, architecture, decisions); it is not a task tracker.

## The flow

```
[Backlog] → [Ready] → [In Progress] → [In Review] → [Validating] → [Done]
              ▲           │                              │
              │   branch + draft PR          tests + coverage + AC validated
              └──── blocked? add `blocked` label, return to Backlog
```

- **Backlog → Ready:** acceptance criteria present and all `Depends on` issues are Done.
- **Ready → In Progress:** self-assign, branch, and open a **draft PR** linking the issue.
- **In Progress → In Review:** PR marked ready-for-review; CI green.
- **In Review → Validating:** approved + CI green; now tests, coverage, and every acceptance criterion are empirically validated (see the **Testing & validation gate** below).
- **Validating → Done:** validation passed → merge → issue auto-closes.

## Milestones

Map 1:1 to [ROADMAP.md](ROADMAP.md): **M0** Foundations + substrate spike · **M1** War-room MVP demo · **M2** Reach & durability. Every issue gets exactly one milestone.

## Label taxonomy

**Type:** `type:feature` · `type:spike` · `type:chore` · `type:docs` · `type:bug`

**Area:** `area:infra` · `area:backbone` · `area:schema` · `area:mcp` · `area:hook` · `area:identity` · `area:demo`

**Priority:** `P0` (blocker/gating) · `P1` (core for its milestone) · `P2` (important, deferrable) · `P3` (future)

**Workflow signals:** `blocked` · `needs-triage` · `good first issue` · `help wanted` · `risk`

## Issue structure

Each issue carries:
- **Title:** `CAU-N — <short imperative>`
- **Body:** Description + Acceptance Criteria checklist + `Depends on:` links + `Epic:` reference.
- **Labels:** one `type:*`, one or more `area:*`, one `P*`, plus signals.
- **Milestone** set; added to the Project board (lands in Backlog).

Epics are tracked issues that link their child `CAU-N` tickets for rollup.

## Conventions for autonomous agents

So a coordinator can dispatch work across multiple agents without collisions:

1. **One ticket, one branch, one PR.** Branch: `cau-<n>-<slug>` (e.g. `cau-7-claim-ledger`).
2. **Link the issue** with `Closes #<n>`; the PR template enforces an AC checklist.
3. **Respect dependencies.** Don't start a ticket whose `Depends on` aren't Done. If unavoidable, mark `blocked` and explain.
4. **Small PRs.** If a ticket grows, split it and file follow-ups.
5. **Spikes produce a written verdict**, not just code (e.g. the substrate spike CAU-2).
6. **Definition of Done:** tests cover the change · coverage threshold met · every acceptance criterion validated · CI green (lint/typecheck/test/build/coverage) · docs updated if behavior changed · linked issue closes on merge.

## Testing & validation gate (required)

Testing is a **first-class, required state** — not an afterthought. **No ticket reaches Done until it is tested and validated.** "Code written" is not "done."

Before a ticket can leave **Validating**, all of the following must hold:
- **Tests cover the new/changed behavior** — unit tests at minimum; **integration tests** wherever the ticket touches the backbone, the MCP tools, or the hook.
- **The coverage threshold is met.** CI enforces a minimum coverage bar; a ticket may not lower it, and new code is expected to be covered.
- **Every acceptance criterion is empirically validated** — demonstrated to actually work via a test, a script, or a recorded run, not merely implemented.
- **CI is green** — lint, typecheck, test, build, and coverage all pass.

`type:spike` tickets are exempt from the coverage bar but still must produce a written, validated verdict.

**Coordinator rule:** do not advance a ticket to Done — and do not let dependent tickets start — until the blocking ticket has passed this gate. As work progresses, each ticket is tested and validated *before* the next dependent ticket begins. Validating is where that check happens.

## Coordinator responsibilities

- **Triage:** keep `needs-triage` empty; keep Ready stocked with unblocked, prioritized work.
- **Sequencing:** surface the gating spike (the substrate decision) first; it blocks the backbone/MCP/hook fan-out.
- **Dispatch:** assign Ready tickets to capable agents; avoid two agents on dependent tickets at once. The natural split after M0 is a **Backbone track** and an **MCP+Hook track** that converge at the demo.
- **Risk watch:** track `risk`-labeled items and the open risks in [DECISIONS.md](DECISIONS.md).

## Branch protection (recommended)
- `main` protected: require PR, green CI (lint/typecheck/test/build), ≥1 review.
- Squash-merge; delete branch on merge.

## Automation (Project workflows)
- New issue → add to Project, column Backlog, label `needs-triage`.
- PR opened linking an issue → card to In Review.
- PR merged → card to Done, branch deleted.
