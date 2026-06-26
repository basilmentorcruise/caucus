# agent-os — Governance Standard

Single source of truth for how every agent, skill, and gate is structured in any project that installs agent-os.
Authored against Anthropic's Skill best-practices. Reusable role personas live globally in `~/.claude/agents/`;
per-project context lives in that project's `CLAUDE.md` and on its GitHub Project board.

> **Status:** being refined round-by-round as each agent is signed off (see `PLAN.md`). The roster table below
> is the FlowScout-era baseline; rows are generalized and the `preplanner` row added as the reviews land.
> Coordinator (Round 1) is signed off and reflected here.

## Contents

- Mental model
- Role roster (model / tools / memory / home)
- Frontmatter standard (agents & skills)
- Memory conventions
- Handoff artifacts & where they live
- Gate protocol & the autonomous loop
- GitHub backbone (labels, columns, naming)
- Authoring rules (skills & descriptions)

---

## Mental model

| Primitive              | Job                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Agent**              | A specialist persona with instructions, tools, and (sometimes) memory. A different _role_.                  |
| **Skill** (`/agent-*`) | A thin slash-command entry point that dispatches an agent with the right context.                           |
| **Gate**               | An agent invocation whose verdict (`PASS/FAIL/BLOCKED`) controls whether the coordinator advances a ticket. |
| **Artifact**           | The structured output one stage hands to the next.                                                          |

The **coordinator** is the only long-running agent; it owns the loop and spawns every other agent.

---

## Role roster

Reasoning/gatekeeping roles = `opus`; lighter execution roles = `sonnet`. The **developer is `opus`** — implementation quality is worth the strongest model. Least-privilege tools. `memory` only where knowledge accumulates.

| Role                    | Model  | Tools                                          | Memory | Home    | One-line job                                                 |
| ----------------------- | ------ | ---------------------------------------------- | ------ | ------- | ------------------------------------------------------------ |
| **coordinator**         | opus   | Agent, Bash(gh/git), Read, Glob, Grep          | yes    | project | Runs the autonomous loop; dispatches, **verifies** gates, merges, ships, runs the per-epic progress-review. |
| **analyst**             | opus   | Read, Glob, Grep, WebSearch, WebFetch, Bash, Write, Edit | yes | global | Gap/feature discovery, prioritization, MVP/V1/V2 roadmap; owns roadmap-readiness gate. |
| **product**             | opus   | Read, Glob, Grep, Bash, Write, Edit            | yes    | global  | PRD + breakdown into vertical-slice tickets w/ ACs; owns ticket-readiness gate. |
| **planner**             | opus   | Read, Glob, Grep, Write, Edit                  | yes    | global  | Human-voice: vision/epic-intent brief + escalation resolution (kickoff/new-epic/escalation only; not per-ticket). |
| **architect**           | opus   | Read, Glob, Grep, Bash, Write, Edit (ADRs only) | yes   | global  | Design-time plan + post-impl architecture review gate; mandates the CI gate set. |
| **designer**            | sonnet | Read, Glob, Grep, Write, Edit (design docs only) | no   | global  | HCI + design-system spec for UI tickets; design-review gate (read-only on code). |
| **security**            | opus   | Read, Glob, Grep, Bash, Write, Edit (security docs only) | yes | global | Threat model + OWASP/leak security gate; owns scanning policy. |
| **developer**           | opus   | Read, Glob, Grep, Bash, Edit, Write            | no     | global  | Implements one ticket test-first; runs + pastes real local checks. |
| **code-reviewer**       | opus   | Read, Glob, Grep, Bash                         | no     | global  | Code-review gate: correctness, smells, DRY, test quality, docs-in-sync (PASS/FAIL/BLOCKED). |
| **qa**                  | sonnet | Read, Glob, Grep, Bash, Edit(tests), Write(tests), **Agent**(E2E fan-out) | yes | global | Per-ticket gate + real-app epic E2E gate (the verified epic DoD). |
| **progress-reviewer**   | opus   | Agent, Read, Glob, Grep, Bash                  | yes    | global  | Per-epic self-correction: re-prioritize board, open correction tickets, adjust epics (board-only). |
| **preplanner**          | opus   | Agent, Read, Glob, Grep, Bash                  | yes    | global  | On-demand full audit + backlog reconciliation + milestone tickets + pinned handoff brief (board-only). |
| **release-coordinator** | sonnet | Read, Glob, Grep, Bash, Write, Edit (CHANGELOG/release only) | no | global | Final SHIP/HOLD/BLOCKED go/no-go; cuts the tagged release + changelog. |
| **docs**                | sonnet | Read, Glob, Grep, Bash, Edit, Write            | no     | global  | Keeps README + STATUS + user docs in sync (verified); per-epic comprehensive pass. |

`Agent` tool is granted to coordinator (orchestration), qa (E2E sub-agent fan-out), and progress-reviewer +
preplanner (specialist fan-out during audit/review). `Edit/Write`
is scoped by role: developer + qa (code/tests), docs (docs only), planner/designer (their spec docs), analyst
(roadmap), product (PRD), architect (ADRs only), security (threat-models only), release-coordinator
(CHANGELOG/release notes only). **All gatekeepers are read-only on the code under review** —
architect writes ADRs only in plan mode, never edits code in review mode.

**Documentation upkeep (every ticket):** docs are part of the work. The developer updates the README/relevant docs
when behavior, interfaces, config, or setup change; the **code-review gate blocks (must-fix)** if they didn't —
including the architecture overview (`docs/sdlc/architecture/ARCHITECTURE.md`) on any architectural change. At
**epic completion** the coordinator runs the **docs** agent for a comprehensive pass, and the release gate confirms
docs reflect the shipped state. Document only built, merged behavior — never planned features.

**Required documentation set (owners):** README + setup/usage + API reference (docs) · STATUS (developer per-ticket,
docs per-epic) · ARCHITECTURE overview + ADRs (architect) · CHANGELOG (release-coordinator). The docs agent is the
backstop that flags any item in the set that is stale, even ones it doesn't own.

---

## Frontmatter standard

**Agents** (`~/.claude/agents/<role>.md` or project `.claude/agents/`):

```yaml
---
name: <role> # lowercase-hyphen
description: > # THIRD PERSON, what + when + 1-2 example triggers (routing rule)
  <what it does>. Use when <trigger conditions>.
model: opus | sonnet
tools: Read, Glob, Grep[, ...] # least privilege; omit nothing — be explicit
color: <ui color>
memory: project # ONLY if the role accumulates knowledge
---
## Role / ## Core Responsibilities / ## Operating Rules / ## Required Output Format
```

- Read project facts from `CLAUDE.md` at runtime; **never hardcode** product names, stacks, or absolute paths.
- Don't lecture on universally-known concepts (SOLID, OWASP) — name and apply them.

**Skills** (`.claude/skills/<name>/SKILL.md`): `name` (lowercase-hyphen, no `claude`/`anthropic`),
third-person `description` (what + when, ≤1024 chars, no XML), `user-invocable`, optional `context: fork`,
`agent`, `argument-hint`. Always handle the no-args fallback.

---

## Memory conventions

- Dir: `.claude/agent-memory/<role>/` (**repo-relative** — never an absolute path).
- `MEMORY.md` is the index (≤200 lines, one line per entry). Individual files carry `name/description/type` frontmatter (`feedback|project|user|reference`).
- Declared namespace **must** match the on-disk dir name. Verify stale memories against code before acting.

---

## Handoff artifacts & where they live

Hybrid: **specs in-repo** (versioned, PR-reviewable) · **tracking + gate verdicts on GitHub**.

| Artifact                                 | Producer                        | Location                                                     |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------ |
| Roadmap (MVP/V1/V2, prioritized)         | analyst                         | `docs/sdlc/roadmap.md` (living)                              |
| PRD (per epic)                           | product                         | `docs/sdlc/prd/PRD-<slug>.md`                                |
| Ticket brief + acceptance criteria       | planner                         | GitHub **issue body**                                        |
| Architecture plan / ADR                  | architect                       | `docs/sdlc/architecture/ADR-<n>-<slug>.md` (+ per-epic plan) |
| Design spec                              | designer                        | `docs/sdlc/design/<slug>-spec.md`                            |
| Threat model                             | security                        | `docs/sdlc/security/<slug>-threat-model.md`                  |
| Implementation report                    | developer                       | **PR description**                                           |
| Review / arch-review / security verdicts | reviewer / architect / security | **PR review** (structured comment)                           |
| QA + E2E report                          | qa                              | **issue/PR comment**                                         |
| Ship decision                            | release-coordinator             | **release issue**                                            |

Every artifact ends with a fenced **`## Required Output Format`** block defined in the producing agent.

---

## Gate protocol & the autonomous loop

**Pipeline:**

```
Kickoff (human-in-loop):  Planner (vision brief + CLAUDE.md seed) → Analyst (RICE roadmap + epics)

Per epic:                 Planner (epic-intent note, optional) → Product (PRD + vertical-slice tickets)

Per ticket (autonomous):  Architect(plan) → Designer* → Security(threat model)
  → Developer (incl. docs) → [Code-review gate (incl. docs check)] → [Architecture-review gate]
  → [Security gate] → [QA + E2E gate] → [Release gate] → coordinator merges & ships
        (* Designer only for UI tickets; Planner never runs inside the per-ticket loop — it is interactive)

Per epic (after the last ticket merges): Docs (comprehensive pass) → QA verified real-app/system E2E (must
actually run + pass) → Release-coordinator cuts the tagged release → **Progress-reviewer** (re-prioritize the
board, open correction tickets, adjust epics autonomously; escalate big pivots) → loop continues.
(On-demand, outside the loop: **Preplanner** runs the full audit/re-plan before a loop or after a big merge wave.)
```

**Self-improving loop:** build → verified test/E2E → progress-review (progress-reviewer) → re-plan/correct → build.
The coordinator independently verifies every load-bearing gate claim (CI, board status, docs diff, E2E ran)
before advancing or merging — a claimed-but-unverifiable step is treated as not done.

**Gate verdict schema** (every gate returns this):

```
gate: <name> · ticket: #<n>
verdict: PASS | FAIL | BLOCKED
reasons: [...]      # required unless PASS
evidence: [...]     # file:line, command output, artifact links
```

**Coordinator routing:**

- `PASS` → advance to next stage.
- `FAIL` → route back to **developer** with `reasons`; increment the ticket's attempt counter.
- `BLOCKED` → open a `needs-attention` issue with full history.

**Circuit-breaker (progress-aware; autonomous-safe):** gates **re-review every developer push** and verify prior
findings are resolved. Trip the breaker when the **same unresolved finding persists 3 rounds** (no progress) —
open a `needs-attention` issue containing the gate history + last verdict, label the ticket `blocked`, and move
the loop to other eligible work. Genuine progress resets the count. No human approval gates otherwise; this is the
only stop.

---

## GitHub backbone

**The Project board is the source of truth and MUST be populated — an empty board is a process failure.**
Every issue created (by analyst, product, or anyone) is **immediately added to the board**, and its Status is
**advanced as it moves through the gates**. Never create an issue without adding it to the board.
**Enforced, not just instructed:** the coordinator runs `scripts/board-audit.sh <project-number>` every cycle —
it flags any issue off-board or with a Status inconsistent with its real state (merged-but-not-Done,
open-PR-but-Todo). A clean run is the evidence. Status-transition ownership is tabled in `conventions.md`; enable
the Project's built-in workflows (auto-add, PR-merged→Done, item-closed→Done) as a safety net.

- **Project:** `FlowScout SDLC` = **#4** (`gh project ... --owner basilmentorcruise`), id `PVT_kwHOB4GO_s4BbKFF`.
  - Add an issue: `gh project item-add 4 --owner basilmentorcruise --url <issue-url>`
  - Set Status: `gh project item-edit --id <item-id> --project-id PVT_kwHOB4GO_s4BbKFF --field-id PVTSSF_lAHOB4GO_s4BbKFFzhV8n8Q --single-select-option-id <opt>`
  - Status options: `Todo`=`f75ad846` · `In Progress`=`47fc9ee4` · `Done`=`98236657`.
- **Status mapping:** new/ready → `Todo`; a ticket with an open PR or in a gate → `In Progress`; merged/closed → `Done`.
  Fine-grained stage is also carried by the `gate:*` labels.
- **Issue types (labels):** `type:epic`, `type:feature`, `type:task`, `type:bug`.
- **Gate labels:** `gate:code-review`, `gate:arch`, `gate:security`, `gate:qa` (current stage).
- **Tier labels:** `mvp`, `v1`, `v2` (set by analyst). **State labels:** `blocked`, `needs-attention`.
- **Branch/PR:** branch `fs-<issue>-<slug>` off `main` (protected); PR `Closes #<issue>`; one ticket → one branch → one PR.

---

## Authoring rules (skills & descriptions)

- Descriptions: third person, state **what + when**, ≤1024 chars, no XML.
- SKILL.md body < 500 lines; files > 100 lines get a table of contents; references one level deep.
- No time-sensitive content as live instructions (quarantine dates in a clearly-labelled history section).
- No committed secrets, real identifiers, or personal absolute paths.
- Scripts: handle errors, no magic constants, list dependencies, forward slashes only.
- Each critical skill/agent ships with **≥3 evaluation scenarios** (see `docs/sdlc/evals/`).
