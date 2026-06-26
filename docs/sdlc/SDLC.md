# The agent-os SDLC — autonomous, self-improving delivery loop

This is the master description of how agent-os builds software. It ties the agents (`agents/`), gates
(`gates.md`), conventions (`conventions.md`), and hooks (`../hooks/`) into one loop. The governance standard
(`GOVERNANCE.md`) holds the roster, frontmatter, memory, and authoring rules; this doc holds the **flow**.

## Principles (non-negotiable)
- **Verify, don't assume** — every claimed step (docs/board/tests/E2E) is confirmed by evidence, not trusted.
- **CI is authoritative** — if it must hold on `main`, it's a CI gate, not a bypassable local hook.
- **The board is the source of truth** — every ticket on the Project board, Status advanced through the gates.
- **Docs are continuous** — README/STATUS current on every merge, and verified.
- **Incremental** — epics encapsulate vertical-slice tickets (≤~2 days) with Given/When/Then ACs.
- **Epic ≠ Done until its real-app/system E2E has actually run and passed** — real data; coverage ≠ done.
- **Self-improving** — build → verified test/E2E → progress-review → re-plan/correct → build.

## The roles at a glance
The long-running **coordinator** owns the loop and dispatches every specialist; it writes no product code.
Upstream (what/why): **planner** (vision, human voice) → **analyst** (RICE roadmap + epics) → **product**
(PRD + vertical-slice tickets). Per ticket (how): **architect** (plan/ADR) → **designer** (UI spec) →
**security** (threat model) → **developer** (implements, test-first). Gates: **code-reviewer** → **architect**
(review) → **security** (review) → **qa** (per-ticket + real-app epic E2E) → **release-coordinator** (SHIP/HOLD).
Self-correction: **progress-reviewer** (per epic) and **preplanner** (on-demand audit). Continuous:
**docs**. Full roster + tools/models in `GOVERNANCE.md`.

## The loop

### Phase 0 — Kickoff (human-in-the-loop, once)
1. **planner** interviews the user → `docs/sdlc/vision.md` + fills the `CLAUDE.md` Product section. *(Gate:
   vision-clarity — no build until the vision exists and Product is not a placeholder.)*
2. **analyst** turns the vision into a RICE-ranked `docs/sdlc/roadmap.md` + MVP/V1/V2 epics on the board.
   *(Gate: roadmap-readiness.)*
3. **architect** (first epic / stack undecided) proposes the stack + reference architecture + the mandated CI
   gate set (lint·format:check·typecheck·layering·dup·test+coverage·build·SCA·gitleaks·SAST) in an ADR;
   **developer** scaffolds the repo + wires CI/hooks. *(Coordinator bootstrap, idempotent.)*
   *(Gate: CI-readiness — the build loop does not start until the CI gate workflow exists and is green on `main`.)*

### Phase 1 — Per epic
4. **product** breaks the epic into vertical-slice tickets with Given/When/Then ACs + `Touches:`/`Depends-on:`,
   on the board. *(Gate: ticket-readiness.)* **security** writes the epic threat model; **designer** specs UI tickets.

### Phase 2 — Per ticket (fully autonomous; coordinator-driven)
5. Coordinator selects a **disjoint batch** (≤ cap, no `Touches:` overlap, deps merged) and per ticket:
   **architect**(plan) → **developer** implements test-first in its own worktree → opens a draft PR.
6. **Gates in order**, each returning `PASS/FAIL/BLOCKED` + evidence:
   **code-reviewer** (judges vs ACs + architect plan, re-reviews every push) → **architect**(review) →
   **security** → **qa**(per-ticket).
   Routing: `PASS`→next; `FAIL`→back to developer; gates re-review the updated PR each push;
   **progress-aware circuit-breaker** (same unresolved finding 3 rounds → `needs-attention` + `blocked`, drop from batch).
7. **release-coordinator** issues `SHIP/HOLD/BLOCKED`. On `SHIP`, the **coordinator** (having independently
   verified CI green + gates + board) squash-merges, closes the issue, Status→Done, and rebases in-flight branches.

### Phase 3 — Epic completion
8. **docs** comprehensive pass (README/STATUS reflect new capabilities) — coordinator verifies the diff landed.
9. **qa** runs the **real-app/system E2E** (scripted ACs + adversarial pass, sandbox third-parties). **The epic
   is not Done until this actually ran and passed** — `BLOCKED`/unrun keeps the epic open + `needs-attention`.
10. **release-coordinator** cuts the tagged release + changelog (deploy deferred until infra exists).

### Phase 4 — Self-improving progress review (closes the loop)
11. **progress-reviewer** reviews the shipped epic vs the vision/roadmap + E2E results → re-prioritizes the
    board, opens correction/improvement tickets, adjusts/inserts epics — **autonomously**. Escalates only big
    pivots (product direction / MVP scope / vision conflict) → planner; a wrong roadmap → analyst. The loop then
    continues on the re-prioritized board. *(On-demand, outside the loop: **preplanner** runs a full audit/re-plan.)*

```
            ┌─────────────────────────── self-improving loop ───────────────────────────┐
            ▼                                                                             │
 planner → analyst → [per epic: product → security/designer →                            │
   [per ticket: architect → developer → code-review → arch-review → security → qa →       │
    release → MERGE ] → docs → real-app E2E → release-cut ] → PROGRESS-REVIEW ────────────┘
   (human)            (autonomous; coordinator drives; circuit-breaker is the only stop)
```

## Per-discipline expectations + gate + verified DoD

| Discipline   | Agent(s)            | Gate (owner)                 | Verified Definition of Done |
| ------------ | ------------------- | ---------------------------- | --------------------------- |
| Planning     | planner             | vision-clarity               | `vision.md` exists; CLAUDE.md Product filled (greped, not assumed). |
| Analysis     | analyst             | roadmap-readiness            | RICE roadmap + MVP cutline + epics on board (re-queried). |
| Product      | product             | ticket-readiness             | Tickets have testable G/W/T ACs + Touches/Depends-on, on board (verified). |
| Architecture | architect           | design-readiness + arch-review | Plan/ADR exists pre-code; post-code: layering/SOLID/no-drift; coverage read from report. |
| UI / Design  | designer            | design-readiness + design-review | Spec (all states + a11y) pre-code; built UI meets spec + WCAG 2.2 AA (static + QA screenshots). |
| Security     | security            | threat-model + security gate | Threat model per epic; gate: Crit/High→FAIL, Med tracked; scans verified to have run. |
| Development  | developer           | (produces; self-DoD)         | ACs covered by real tests; coverage met; local checks green (output pasted); docs in PR. |
| Code quality | code-reviewer       | code-review                  | Correctness/smells/DRY/test-quality; docs-in-sync must-fix; `PASS/FAIL/BLOCKED`. |
| Testing / QA | qa                  | per-ticket + epic E2E        | ACs tested; coverage met; **real-app E2E actually ran + passed** (else BLOCKED). |
| Release      | release-coordinator | release (SHIP/HOLD/BLOCKED)  | All gates verified PASS, CI green, ACs met, docs current, real E2E ran; tag+changelog. |
| Docs         | docs                | (continuous; code-review enforces) | The doc set (README/STATUS/ARCHITECTURE/setup/usage/API/ADRs/CHANGELOG) current + owned; verified by running the commands. |
| Self-correct | progress-reviewer / preplanner | progress-review     | Board reflects reality; warranted corrections filed before the next epic. |

## Gate protocol, circuit-breaker, and the verified DoD
See `gates.md` for the gate sequence, the unified verdict schema, coordinator routing, the 3-fail
circuit-breaker, and the full verified Definition of Done (ticket-level and epic-level).

## Conventions
See `conventions.md` for epic/ticket conventions (vertical slices, Given/When/Then, Touches/Depends-on), the
GitHub board backbone (labels, Status mapping), branch/PR naming, and the artifact map. Templates in `templates/`.
