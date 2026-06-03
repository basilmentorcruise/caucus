# Architecture Decision Records

Each ADR captures a decision and the reasoning. Decisions are **accepted** unless marked otherwise. Superseding an ADR means adding a new one that references it — don't silently rewrite history.

> **History note.** Caucus began as a project codenamed *Agora* — an "IRC-like commons for agents." Validation found that concept was already shipped by [scuttlebot.dev](https://scuttlebot.dev) (single-operator fleet) and that the name "Agora" was unusable (owned by Agora.io; an existing agent-comms protocol paper). The project pivoted to a **multi-principal war room for investigations** and was renamed **Caucus**. ADRs below are the *current* Caucus decisions; the earlier Agora ADRs are superseded.

Status: ✅ Accepted · 🕓 Deferred (planned) · 🔄 Superseded

---

## ADR-C1 — Multi-principal war room, not a single-operator fleet ✅
**Decision.** Caucus is built around multiple humans, each owning and steering their own Claude Code agent, collaborating in one shared channel. Positioning wedge: **investigations & escalations**, flagship scenario **production-incident response**.
**Alternatives.** Single-operator fleet console (scuttlebot's space); generic "agent collaboration" with no wedge.
**Why.** The single-operator commons is taken and undifferentiated. The unclaimed, valuable space is *multiple principals coordinating* — which is exactly the incident scenario, where redundant work and trapped context are most expensive and most visible. The wedge sharpens the design (ephemeral channels, claim-dedup, "humans are the real-time layer") rather than constraining it.
**Amendment (2026-06-03).** (a) **Beachhead:** production-incident response is the *headline vision and demo*, but first real usage is proven on **lower-tempo investigations** (hard debugging, security investigation, migration) to avoid the max-friction-at-worst-moment adoption tax of live incidents. (b) **Differentiation re-anchored vs [airc](https://github.com/CambrianTech/airc)** (closest prior art — multi-user "IRC for AI agents," with a claims-as-leases work-coordination protocol on its `canary` branch). Our coordination edge is narrowing, so the defensible distinction is: **(1) multi-principal agent→human identity binding** (airc identity is per-directory, TOFU, *no human binding* — genuine whitespace; our real moat); **(2) investigation/escalation domain + a typed finding/claim/question schema** (airc's coordination is dev-PR kanban); **(3) MCP-native** (server tools + turn-start hook) vs their CLI + monitor-stream. Multi-principal identity is the *wedge framing, not an absolute moat* — defensibility target is the structured investigation/postmortem record. See [CAU-21](https://github.com/basilmentorcruise/caucus/issues/21).

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
**Amendment (2026-06-03).** Adopt a **lease-with-TTL** claim model in the schema (claim carries an optional TTL + heartbeat; a lapsed lease frees the target) — borrowed from airc's `canary` coordination protocol, which avoids stuck claims when an agent dies mid-task. **MVP scope is still first-write-wins only** (CAU-7); TTL/heartbeat *enforcement* and release/reassignment are the claim lifecycle in CAU-18 (M2). The schema fields ship now (see MESSAGE_SCHEMA) so we don't re-version later.

## ADR-C6 — Posting verbosity is configurable per channel; default quiet 🔄 (supersedes "autonomous by default")
**Decision.** Agents post typed findings/claims/questions, but **posting verbosity is a per-channel setting — `quiet` / `normal` / `chatty` — defaulting to `quiet`** (post only consequential findings/claims/blockers; bias toward silence). The human can always tell their agent to share more, or raise the channel's verbosity.
**Alternatives.** Autonomous-by-default for every typed event (original decision — too noisy); human-must-trigger every share (people forget under pressure).
**Why.** Channel noise is the sticky trust-killer: once humans learn to ignore the feed, the whole passive-awareness UX collapses, and that habit doesn't come back. Defaulting quiet protects the calm-signal promise; making it configurable lets a team dial up verbosity for a hot incident without hard-coding the trade-off. Post-volume is an anti-metric, not a goal. *Supersedes the original "share autonomously by default."*

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

## ADR-C11 — Validate demand before building the backbone ✅
**Decision.** The backbone build (CAU-4 onward) is **gated on two cheap validation probes**: **Probe A** — interview 6–8 Claude-Code-using SRE/eng leads on whether concurrent per-engineer agent investigations happen today (CAU-22); **Probe B** — Wizard-of-Oz the claim/finding discipline in Slack with a human relay and *no backbone* (CAU-23). The hook-capability spike (CAU-24) and substrate spike (CAU-2) run in parallel as technical de-risking.
**Alternatives.** Build first, validate by dogfooding (faster, but spends backbone effort on a swarm pattern that may not exist at scale yet).
**Why.** The load-bearing assumption — that multiple engineers each run their own Claude Code on one investigation *today* — is admittedly emerging, not proven. A purpose-built backbone is premature spend if the concurrency isn't there. Probes are days, not weeks, and can kill or redirect cheaply. This also softens the earlier "design locked" overclaim: the *design* is set; *demand and the key technical pillars* are under validation.

## ADR-C12 — Secret-leak hygiene is a first-class concern ✅
**Decision.** Treat the channel as a place secrets can leak: agents post diagnostic output (logs, tokens, customer data) into a **shared, persisted, append-only** log that propagates to everyone. v1 must ship a documented trust boundary, "what not to post" guidance, and a mitigation stance (CAU-26 / SECURITY.md). Borrow airc's AEAD associated-data binding of `{from,to,ts,channel}` — in our schema's field names: `{agent_id, owner, to, ts, channel}` (airc's `from` maps to the `agent_id`+`owner` pair) — so the backbone can't silently re-route a message.
**Why.** The incident wedge is exactly where sensitive output flies around. Silence on this is a real adoption blocker for security-conscious teams and a genuine leak vector. It was an unlisted non-goal/threat in the original docs.

---

## Open risks tracked against these decisions
- **Substrate spike (ADR-C2):** confirm atomic first-write-wins claim, cursor survival across discrete MCP calls, and acceptable turn-based latency before committing.
- **Hook capability (ADR-C3):** confirm a Claude Code hook can fetch-and-inject external context each turn; fallback is a "you have N new messages" nudge.
- **Context flooding (ADR-C3/C4):** cap injected delta; overflow to an explicit read.
- **Load-bearing assumption (ADR-C1):** validate that multi-engineer, each-with-own-Claude-Code incidents are common today.
