# Caucus — project context for Claude Code

**Caucus** is an open-source **agent war room for investigations & escalations**. Multiple engineers each run their own Claude Code session; those sessions share an ephemeral channel via an **MCP server** + a **turn-start hook**, so agents post typed findings, **claim work before doing it** (dedup), and a human's context propagates to everyone's agents. Multi-principal **agent→human identity** is the wedge. Turn-based; humans are the real-time layer. Built on a lightweight **purpose-built backbone** (append-only log, first-write-wins claim ledger, cursors, seatbelts) — not an Ergo fork.

## Source of truth
- `docs/VISION.md` · `docs/ARCHITECTURE.md` · `docs/DECISIONS.md` (ADRs — binding) · `docs/MESSAGE_SCHEMA.md` · `docs/ROADMAP.md` · `docs/GITHUB_PROJECTS.md`.
- **Tickets live only on the GitHub Project board**, never in repo `.md` files. Repo: `basilmentorcruise/caucus`, Project #3. `CAU-N = issue #N`.

## How work is run
This project is delivered by a coordinator + specialist agent team. **Run `/coordinator`** to pick up tickets and drive them through the SDLC. The specialists live in `.claude/agents/` (`caucus-architect`, `caucus-developer`, `caucus-tester`, `caucus-security`, `caucus-product`, `caucus-designer`, `caucus-reviewer`).

## Hard rules
- **Testing/validation is a required gate.** Nothing reaches Done until tests cover the change, the CI coverage threshold is met, **every acceptance criterion is empirically validated** (run it, don't assume), and CI is green. See `docs/GITHUB_PROJECTS.md` → *Testing & validation gate*. Board flow: Backlog → Ready → In Progress → In Review → **Validating** → Done.
- **Demand validated (ADR-C11, amended):** the original demand probes (CAU-22/23) were waived by the owner; demand was instead validated by the **CAU-85 dogfood verdict (GO, owner-ratified 2026-06-10)**. M0 and M1 have shipped; **M2+ is active** — see the pinned coordinator brief (board issue #86) for the M2 sequence.
- **`main` is protected** — all changes via PR; branch `cau-<n>-<slug>`; PR body uses the template with `Closes #<n>`.
- Respect every ADR; don't introduce architecture without an ADR change. **M2 features that expand architecture or the message schema (e.g. evidence store, typed steer, token-issuer, federation) require an ADR (or schema-version) change first** — propose it, don't silently diverge. CAU-16 (real-time SDK) and federation stay deferred (ADR-C4 / ADR-C9).
- Posting is **quiet by default** (ADR-C6); the channel is a shared persisted log — **never post secrets** (ADR-C12).

## Tech
TypeScript pnpm monorepo: `packages/schema | backbone | mcp-server | hook`, `examples/`. Commands: `pnpm lint typecheck test build`, `pnpm test:integration`.

## Backbone

Resolved by the agents at runtime — never hardcoded in their prompts.

- Repo: `basilmentorcruise/caucus`
- Board: **Caucus #3**  id `PVT_kwHOB4GO_s4BZkEy`
- Status field id `PVTSSF_lAHOB4GO_s4BZkEyzhUh3Lk`. This board has a richer column set than the canonical
  Todo/In Progress/Done; **mapping (finalized):**
  - icebox / unrefined → `Backlog`=`af86a0bd`
  - ready to start (= canonical "Todo") → `Ready`=`2bb10241`
  - implementation underway → `In Progress`=`6ccd66ba`
  - in a code/arch/security gate (open PR) → `In Review`=`8da7e7f4`
  - in QA / E2E validation → `Validating`=`209ba226`
  - merged / closed (= canonical "Done") → `Done`=`48269c82`
- Concurrency cap: 3
- Branch prefix: `ca`  (branches are `ca-<issue>-<slug>`)
- Branch protection: confirm per repo

> Migration note: the project-local `caucus-*` agents are legacy clones — the canonical roles now run from
> `~/.claude/agents/`. Retire the `caucus-*` files once you've confirmed the global roles cover them.
