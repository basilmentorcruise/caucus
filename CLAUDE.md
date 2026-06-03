# Caucus — project context for Claude Code

**Caucus** is an open-source **agent war room for investigations & escalations**. Multiple engineers each run their own Claude Code session; those sessions share an ephemeral channel via an **MCP server** + a **turn-start hook**, so agents post typed findings, **claim work before doing it** (dedup), and a human's context propagates to everyone's agents. Multi-principal **agent→human identity** is the wedge. Turn-based; humans are the real-time layer. Built on a lightweight **purpose-built backbone** (append-only log, first-write-wins claim ledger, cursors, seatbelts) — not an Ergo fork.

## Source of truth
- `docs/VISION.md` · `docs/ARCHITECTURE.md` · `docs/DECISIONS.md` (ADRs — binding) · `docs/MESSAGE_SCHEMA.md` · `docs/ROADMAP.md` · `docs/GITHUB_PROJECTS.md`.
- **Tickets live only on the GitHub Project board**, never in repo `.md` files. Repo: `basilmentorcruise/caucus`, Project #3. `CAU-N = issue #N`.

## How work is run
This project is delivered by a coordinator + specialist agent team. **Run `/coordinate`** to pick up tickets and drive them through the SDLC. The specialists live in `.claude/agents/` (`caucus-architect`, `caucus-developer`, `caucus-tester`, `caucus-security`, `caucus-product`, `caucus-designer`, `caucus-reviewer`).

## Hard rules
- **Testing/validation is a required gate.** Nothing reaches Done until tests cover the change, the CI coverage threshold is met, **every acceptance criterion is empirically validated** (run it, don't assume), and CI is green. See `docs/GITHUB_PROJECTS.md` → *Testing & validation gate*. Board flow: Backlog → Ready → In Progress → In Review → **Validating** → Done.
- **Probes before backbone (ADR-C11):** the backbone build (CAU-4+) is gated on the two demand probes (CAU-22, CAU-23), which are **human-run**.
- **`main` is protected** — all changes via PR; branch `cau-<n>-<slug>`; PR body uses the template with `Closes #<n>`.
- Respect every ADR; don't introduce architecture without an ADR change. Keep MVP scope tight (no M2 features).
- Posting is **quiet by default** (ADR-C6); the channel is a shared persisted log — **never post secrets** (ADR-C12).

## Tech
TypeScript pnpm monorepo: `packages/schema | backbone | mcp-server | hook`, `examples/`. Commands: `pnpm lint typecheck test build`, `pnpm test:integration`.
