# Conventions — epics, tickets, board backbone, naming

How work is structured and tracked. The flow is in `SDLC.md`; gates in `gates.md`.

## Epics & tickets
- **Epic** = a vision-level capability (analyst opens it; `type:epic` + a tier label). Carries a problem, value
  hypothesis, RICE, tier, rough scope, success metric, dependencies. Not a spec.
- **Ticket** = a **vertical slice**: a thin end-to-end capability that ships independently, ≤~2 days. Split
  anything larger. Avoid horizontal (backend-only/frontend-only) splits that serialize work.
- **Acceptance criteria**: every ticket has **Given/When/Then** scenarios, testable without reading the code,
  including edge + error states. These drive QA's tests.
- **Metadata for batching**: each ticket carries `Touches:` (modules/areas — product's first pass, architect
  refines) and `Depends-on:` (issue numbers). The coordinator batches disjoint, dependency-free tickets.

## GitHub board backbone (the source of truth)
**Every issue is added to the board immediately and its Status advanced as it moves through the gates. An empty
or stale board is a process failure.** Backbone facts (board number, project id, Status field + option ids,
concurrency cap, branch prefix) live in the target repo's `CLAUDE.md` `## Backbone` — agents resolve them at
runtime and never hardcode them.

- **Issue types (labels):** `type:epic`, `type:feature`, `type:task`, `type:bug`.
- **Tier labels:** `mvp`, `v1`, `v2` (analyst). **Stage labels:** `gate:code-review`, `gate:arch`,
  `gate:security`, `gate:qa` (current stage). **State labels:** `blocked`, `needs-attention`.
  **Brief:** `preplanner-brief` (pinned coordinator handoff).
- **Status mapping:** new/ready → `Todo`; open PR or in a gate → `In Progress`; merged/closed → `Done`.
  Fine-grained stage is carried by the `gate:*` labels.
- **Status-transition ownership (who moves what, when):**

  | Transition | Owner | Trigger |
  | ---------- | ----- | ------- |
  | → `Todo` | analyst (epics) / product (tickets) | on issue creation (then verify it's on the board) |
  | → `In Progress` | coordinator | the ticket's PR opens / it enters a gate |
  | → `Done` | coordinator | PR squash-merged + issue closed |
  | `blocked` / `needs-attention` | coordinator | circuit-breaker / external blocker |

- **Verified every cycle:** the coordinator runs `scripts/board-audit.sh <project-number>` — it flags any issue
  that is off-board or whose Status is inconsistent with its real state (merged-but-not-Done, open-PR-but-Todo).
  A clean run is the evidence that the board is the source of truth.

## Branch / PR naming
- Branch: `<prefix>-<issue>-<slug>` off `main` (prefix from `CLAUDE.md` `## Backbone`). One ticket → one branch → one PR.
- PR body `Closes #<issue>`; opened as **draft** until the developer's local checks are green.
- Branch protection is unavailable on free private repos → PRs/merge-discipline are coordinator-enforced.

## Handoff artifacts & where they live
Hybrid: **specs in-repo** (versioned, PR-reviewable) · **tracking + gate verdicts on GitHub**.

| Artifact                       | Producer            | Location                                     |
| ------------------------------ | ------------------- | -------------------------------------------- |
| Vision brief                   | planner             | `docs/sdlc/vision.md`                        |
| Roadmap (RICE, MVP/V1/V2)      | analyst             | `docs/sdlc/roadmap.md` (living)              |
| PRD (per epic)                 | product             | `docs/sdlc/prd/PRD-<slug>.md`                |
| Ticket ACs + metadata          | product             | GitHub **issue body**                        |
| Architecture overview (living) | architect           | `docs/sdlc/architecture/ARCHITECTURE.md`     |
| Architecture plan / ADR        | architect           | `docs/sdlc/architecture/ADR-<n>-<slug>.md`   |
| Design spec / design system    | designer            | `docs/sdlc/design/<slug>-spec.md` · `system.md` |
| Threat model                   | security            | `docs/sdlc/security/<slug>-threat-model.md`  |
| E2E runbook                    | architect/developer | `docs/sdlc/e2e-runbook.md`                   |
| Implementation report          | developer           | **PR description**                           |
| Gate verdicts                  | gatekeepers         | **PR review / comment**                      |
| QA + E2E report                | qa                  | **issue/PR comment**                         |
| Ship decision / release        | release-coordinator | **release issue** + `CHANGELOG.md`           |
| Progress review                | progress-reviewer   | **board** (corrections + pinned brief)       |

Templates for the in-repo artifacts and GitHub issues/PRs are in `templates/`.
