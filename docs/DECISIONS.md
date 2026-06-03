# Architecture Decision Records

Each ADR captures a decision and the reasoning. Decisions are **accepted** unless marked otherwise. Superseding an ADR means adding a new one that references it — don't silently rewrite history.

> **History note.** Caucus began as a project codenamed *Agora* — an "IRC-like commons for agents." Validation found that concept was already shipped by [scuttlebot.dev](https://scuttlebot.dev) (single-operator fleet) and that the name "Agora" was unusable (owned by Agora.io; an existing agent-comms protocol paper). The project pivoted to a **multi-principal war room for investigations** and was renamed **Caucus**. ADRs below are the *current* Caucus decisions; the earlier Agora ADRs are superseded.

Status: ✅ Accepted · 🕓 Deferred (planned) · 🔄 Superseded

---

## ADR-C1 — Multi-principal war room, not a single-operator fleet ✅
**Decision.** Caucus is built around multiple humans, each owning and steering their own Claude Code agent, collaborating in one shared channel. Positioning wedge: **investigations & escalations**, flagship scenario **production-incident response**.
**Alternatives.** Single-operator fleet console (scuttlebot's space); generic "agent collaboration" with no wedge.
**Why.** The single-operator commons is taken and undifferentiated. The unclaimed, valuable space is *multiple principals coordinating* — which is exactly the incident scenario, where redundant work and trapped context are most expensive and most visible. The wedge sharpens the design (ephemeral channels, claim-dedup, "humans are the real-time layer") rather than constraining it.

## ADR-C2 — Substrate: lightweight purpose-built backbone, not an Ergo fork ✅ / 🕓(spike)
**Decision.** Build a small purpose-built backbone (append-only log, claim ledger, cursors, seatbelts) behind an implementation-agnostic interface — **pending the M0 spike** (see Roadmap) confirming no core property is surprisingly hard. Keep an Ergo-backed adapter as a reversible fallback.
**Alternatives.** Fork Ergo (the original Agora plan).
**Why.** Ergo's payoff was "agents are IRC clients → channels/history/clients for free." Caucus's clients are Claude Code sessions over MCP, not IRC clients, so that payoff evaporates; what's left (free IRC-client observability) is a nice-to-have. An Ergo fork adds a protocol hop, a Go fork for claim+dedup, and a 4094-byte tag budget — cost without benefit here. A purpose-built service maps 1:1 to our primitives and is less total code for *this* concept. Reversible via the shared interface. *Supersedes the Agora "fork Ergo" decision.*

## ADR-C3 — Integration: MCP server + Claude Code hook ✅
**Decision.** Agents reach Caucus through an MCP server (post/read/claim/subscribe/discover). A Claude Code turn-start hook auto-injects new-since-checkpoint messages for passive awareness.
**Alternatives.** Native SDK only (more adoption friction); rely on the agent remembering to call a read tool (unreliable).
**Why.** Claude Code is already an MCP client, so "point your session at Caucus" is near-zero friction. The hook solves the core problem that turn-based agents won't reliably poll — awareness becomes automatic without a persistent listener. Native SDK is deferred (M2).

## ADR-C4 — Turn-based + checkpoint reads; humans are the real-time layer ✅
**Decision.** No sub-second autonomous bus. Agents catch up at turn start (via the hook) and before claiming work. The humans — present and fast during an incident — supply real-time reaction.
**Alternatives.** Background listener interrupting agents mid-task for true real-time.
**Why.** Claude Code is turn-based and human-driven; a mid-task interrupt is the jankiest, hardest part and can derail an agent. The incident scenario *has* humans in the loop, so we don't need agents to be real-time. Mid-task reactivity is a deferred enhancement for unattended cases.

## ADR-C5 — Claim-before-you-work as the dedup primitive ✅
**Decision.** Agents `claim(target)` before starting a sub-task. The claim ledger is **first-write-wins and atomic**; a granted claim is also posted as a `claim` message so the hook surfaces it. Claims are advisory-but-visible (the server records truth; agents are nudged to respect it), not hard locks.
**Alternatives.** No coordination (collisions); hard locks (brittle, deadlock-prone).
**Why.** "Stop debugging the same thing twice" is the headline value; it needs a concrete mechanic. First-write-wins is trivially correct with a single-writer backbone. Soft-but-visible claims fit a fast-moving investigation better than locks.

## ADR-C6 — Agents share autonomously by default; humans can override ✅
**Decision.** Agents post typed findings/claims/questions proactively at natural beats; the human can also instruct a share. Posts are typed so the channel stays signal-dense, not a transcript dump.
**Alternatives.** Human-must-trigger every share (people forget under pressure).
**Why.** If sharing depends on the human remembering, it won't happen mid-incident. Typing + significance-biased prompting keeps autonomy from becoming noise (post-volume is an anti-metric, not a goal).

## ADR-C7 — Multi-principal identity: agent → human, anchored server-side ✅ / 🕓(issuer)
**Decision.** Every message is stamped `agent-id` + `human owner`. For MVP, identity comes from a per-session join token (shared team secret or simple issued token) mapped and anchored server-side so the owner can't be forged. A token-issuer service and cross-org identity are deferred (M2).
**Alternatives.** Flat nicks (scuttlebot's model — no human binding); trust client-asserted owner (spoofable).
**Why.** Multi-principal identity *is* the wedge — the room must know which teammate stands behind each agent. Anchoring server-side prevents spoofing without building an issuer prematurely.

## ADR-C8 — Seatbelts: rate limit + loop/duplicate detection ✅
**Decision.** Per-agent posts/min cap (over-cap rejected with an actionable error the agent sees) and loop/dup detection (drop near-identical consecutive posts from the same agent).
**Why.** Autonomous posting plus agents reacting to each other is a predictable flood/loop risk that would wreck the calm-observation promise and burn tokens. Cheap to enforce in a backbone we own.

## ADR-C9 — Intra-team, single shared server; no federation in v1 🕓
**Decision.** One shared backbone, one team/org. No cross-org channels or multi-server federation in v1.
**Why.** The incident wedge is intra-team — everyone's on the same Slack already. Single-server keeps identity, claims, and the log trivially consistent and sidesteps the hardest problem (federation), which becomes far-future once there's pull.

## ADR-C10 — MVP = the two-terminal claim handoff ✅
**Decision.** v1 ships the smallest slice that proves the point: 2–3 Claude Code sessions in one ephemeral channel, claim-based dedup, hook-driven awareness, a human-injected steer propagating, and a seatbelt blocking a loop. (Full M1 demo definition in the [Roadmap](ROADMAP.md).)
**Why.** That single beat — an agent visibly avoiding redundant work because it saw another's claim — is the entire value, and it's the README demo and contributor magnet.

---

## Open risks tracked against these decisions
- **Substrate spike (ADR-C2):** confirm atomic first-write-wins claim, cursor survival across discrete MCP calls, and acceptable turn-based latency before committing.
- **Hook capability (ADR-C3):** confirm a Claude Code hook can fetch-and-inject external context each turn; fallback is a "you have N new messages" nudge.
- **Context flooding (ADR-C3/C4):** cap injected delta; overflow to an explicit read.
- **Load-bearing assumption (ADR-C1):** validate that multi-engineer, each-with-own-Claude-Code incidents are common today.
