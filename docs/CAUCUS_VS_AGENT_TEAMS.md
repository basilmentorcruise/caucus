# Caucus vs Claude Code Agent Teams

Claude Code "Agent Teams" (launched February 2026) and Caucus solve adjacent but distinct
problems. This page states the boundary clearly so you can pick the right tool — or use both.

---

## Boundary table

| Dimension | Claude Code Agent Teams | Caucus |
|---|---|---|
| **Machines** | Single machine | Cross-machine (each engineer on their own host) |
| **Operators / humans** | Single operator controlling all agents | Many humans, each owning and steering exactly one agent |
| **Agent identity** | AI↔AI; agents are sub-tasks of one session | Agent→human anchored: every message carries which teammate stands behind it |
| **Coordination primitive** | Shared task list (git worktrees); self-claim | First-write-wins claim ledger; hook-injected passive awareness |
| **Communication** | P2P mailbox between agents | Append-only typed log; all sessions share one channel |
| **Record of work** | Ephemeral session history | Typed, exportable investigation record (catch_me_up / postmortem skeleton) |
| **Setup** | Built into Claude Code; zero additional infra | Shared backbone + MCP server + turn-start hook (npm-installable, one command) |
| **Trust model** | One operator trusts all agents implicitly | Multi-principal: server-anchored identity, per-participant tokens, no owner forgery |

---

## What Agent Teams does well

Agent Teams is the right choice when:

- **All work is on one machine** — no remote participants, no cross-host coordination needed.
- **One person is driving** — a single engineer fans out to 2–16 sub-agents working a large
  codebase in parallel (refactors, multi-package changes, parallel test runs).
- **You want zero extra infra** — it is built directly into Claude Code with no server to run.
- **Tasks are well-defined and divisible** — each sub-agent gets a bounded slice of a single
  codebase; self-claim prevents intra-session duplication across worktrees.

---

## When to reach for Caucus instead

Reach for Caucus when **any** of these are true:

1. **Multiple humans are involved** — engineers on different machines, each with their own Claude
   Code session, swarming the same incident or investigation. Agent Teams has no concept of a
   second human.
2. **"Which teammate's agent said that?" matters** — attributing a finding to a specific human
   (not just an agent identifier) is load-bearing for incident accountability and the postmortem.
   Caucus anchors agent→human identity server-side; it cannot be spoofed.
3. **Context needs to travel across machines** — a steer, a hard-won fact, or a `catch_me_up`
   digest that must reach agents on other people's laptops. Caucus is the propagation layer.
4. **You need a typed, exportable investigation record** — Caucus's `catch_me_up` tool produces a
   structured digest (open/resolved claims, findings, unanswered questions, participant summary)
   and a copy-pasteable postmortem skeleton, readable without an active session.

---

## The three surviving differentiators

### 1. Multi-principal agent→human anchored identity

Every Caucus message is stamped with both an `agent_id` and a `human owner`, resolved server-side
from a per-participant bearer token. A client cannot assert an owner the server does not map to its
token. Agent Teams has no human-binding layer: the agents in a session are sub-tasks of a single
operator; there is no concept of "alice's agent vs. bob's agent."

This is the load-bearing property for incident accountability: the war-room record is reliably
attributable.

### 2. Cross-machine, cross-working-tree

Agent Teams works within one Claude Code process (across git worktrees on one host). Caucus is a
shared backbone that engineers on separate machines join. A finding alice's agent posts on her
laptop arrives in the hook-injected context of bob's session on his laptop, with no manual copy.

### 3. Typed investigation record

Caucus's message schema carries typed findings (`finding`, `claim`, `steer`, `question`, `answer`,
`note`) and the `catch_me_up` tool projects them into a structured digest — who claimed what,
what's resolved, what's open, what's unanswered — plus an exportable postmortem skeleton. Agent
Teams produces no structured record independent of the session history.

---

## Using both

Agent Teams and Caucus are not mutually exclusive. A common composition:

- Each engineer runs **Agent Teams** within their own Claude Code session to fan out sub-tasks
  across local worktrees.
- All engineers join a **Caucus channel** so their sessions share findings, claims, and steers
  across machines.

Caucus sees the top-level session; the internal Agent Teams sub-agent orchestration is invisible to
Caucus (and should stay that way — sub-task chatter is not war-room signal).

---

## See also

- [docs/DEPLOY_DISTRIBUTED.md](DEPLOY_DISTRIBUTED.md) — cross-machine quickstart: stand up a
  shared backbone and connect two participants end-to-end.
- [docs/VISION.md](VISION.md) — north star, target users, jobs-to-be-done, non-goals.
- [docs/DECISIONS.md](DECISIONS.md) — ADR-C1 (multi-principal wedge), ADR-C4 (turn-based,
  humans-as-real-time-layer), ADR-C7 (identity anchoring), ADR-C9 (single shared server).
- [SECURITY.md](../SECURITY.md) — trust boundary and secret-leak threat model.
