# Roadmap

Caucus ships in vertical slices — each milestone is something you can *run*. Milestones map 1:1 to GitHub Milestones; **tickets live only on the GitHub Project board** (see [GITHUB_PROJECTS.md](GITHUB_PROJECTS.md)), never in this repo.

> Dates are omitted — this is a contributor-driven OSS project. Sequencing and the gating spike are what matter.

## Milestone overview

| Milestone | Theme | Outcome | Status |
|-----------|-------|---------|--------|
| **M0** | Foundations + substrate spike | Repo, CI, schema v0 frozen, backbone interface, **substrate decision proven** | ▶ Active |
| **M1** | War-room MVP demo | The two-terminal claim handoff runs end-to-end from the README | Planned |
| **M2+** | Reach & durability | Native SDK, observability surface, claim lifecycle, digests, identity→federation | Future |

---

## M0 — Foundations + substrate spike ▶
**Goal:** stand up the skeleton and settle the one open architectural question before parallel build.

**The gating spike** must prove, with throwaway code:
1. The backbone accepts a typed message, appends it to a per-channel log, and returns it to a second subscriber via `read_channel(since=cursor)`.
2. `claim` is **atomic first-write-wins** under two near-simultaneous callers.
3. A `subscribe` cursor **survives across separate MCP request/response calls** (MCP has no persistent push — confirm the cursor/poll model).
4. Turn-based latency is fine with 3 sessions (seconds, not ms).
5. Transport chosen and justified (default: **HTTP + cursor polling**, since the hook already polls per turn).

Exit is a written go/no-go on "purpose-built"; if any of 1–3 is surprisingly hard, fall back to an Ergo adapter behind the same interface.

**Exit criteria:**
- Repo, CI (lint+typecheck+test+build), license, monorepo skeleton.
- Substrate decision recorded with transport named.
- Message schema `v0` ratified and frozen (types incl. `claim`).
- Backbone interface (`append`/`readSince`/`claim`/`subscribe`/`describe`) defined as a typed contract with an in-memory reference impl.
- End-to-end "hello": a script posts a message and reads it back.

## M1 — War-room MVP demo ★ headline
**Goal:** deliver the demo end-to-end.

> **Literal demo:** Three engineers each start a Claude Code session and join an ephemeral channel `war-room-incident-42`. Engineer A's agent is told "investigate the login 500s"; it `claim`s "auth-timeout repro" and posts a `finding`. Before any human re-reads anything, B's and C's sessions — on their next turn — have A's claim and finding auto-injected by the hook. C's agent, about to also repro the auth timeout, sees the claim and instead claims a *different* lead (DB pool), avoiding duplicate work. B's agent asks a `question`; A's agent `answer`s it `resolved`. Then Engineer C (the human) types a steer — "check if the 14:02 deploy correlates" — and on the next turn it appears in A's and B's sessions. No duplicate claim succeeds; the seatbelt blocks a deliberately looping post.

**Exit criteria:**
- 2–3 real Claude Code sessions join one ephemeral channel via the MCP server.
- `post`/`post_finding`, `read_channel`, `claim`, `list`/`describe`, channel create/join work as MCP tools.
- Hook auto-injects new-since-checkpoint messages each turn — no manual read needed for awareness.
- Claim is first-write-wins; a duplicate claim is visibly rejected and the agent redirects.
- Human-injected context propagates to the others within one turn.
- Identity (agent→human) is stamped on every message and shown in injected context.
- Seatbelt blocks a runaway loop/flood in the demo.
- README quickstart reproduces the demo on a clean machine.

## M2+ outlook (not scheduled)
- **Native real-time SDK** — persistent reactive agents beyond turn-based polling.
- **Human observability surface** — read-only viewer (or an Ergo mirror for IRC clients).
- **Claim lifecycle** — reassignment, expiry, done-state semantics.
- **"Catch me up" digests** — LLM summary over the typed log (strong retention hook; the incident-commander persona will want export-to-postmortem).
- **Token-issuer identity → federation** — cross-org, multi-server.
- **Python SDK** — for non-Claude-Code clients.

---

## Cut lines (explicitly not in v1)
Native SDK · web dashboard/digests · federation/multi-server · token-issuer service · persistent archival/retention · threaded UI · sub-second streaming · Python SDK. Each is a clean post-MVP increment, not a retrofit.
