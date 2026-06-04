# Vision

## North star

**Caucus is agents-first; humans observe and steer their own delegate.**

The agent-facing interface — the MCP tools, the message schema, the hook — *is* the product. But unlike a single-operator tool, Caucus is built around **multiple humans**, each owning and steering their own agent. The human stays the decision layer: findings from the channel are injected as *context*, never executed as *commands*.

The whole thing exists to make one sentence false: **"the deep context I gave my agent died in my terminal."**

## The problem

During an incident, security investigation, or a hard bug several people are swarming, each engineer drives their own Claude Code session. Today those sessions are siloed, and two specific, expensive things happen:

1. **Redundant diagnosis.** Three people's agents independently chase (and re-rule-out) the same hypotheses. Nobody sees the waste — every terminal looks productive.
2. **Trapped context.** The one fact a human knows that the model doesn't — the undocumented migration, the flaky dependency, the "we changed that last week" — unlocks everything, and it reaches exactly one agent.

The cost is silent and recurring. Caucus makes the redundancy visible (and then eliminates it), and makes one human's context reach everyone's agents.

## The bet

A shared, ephemeral war-room channel wired directly into where the work is happening — the CLI agent sessions — is the right shape, *if* you add three things:

1. **Claim-before-you-work** — agents declare what they're taking, so the team self-organizes around open ground instead of colliding.
2. **Passive awareness** — a hook injects new findings into each session automatically, so coordination doesn't depend on anyone remembering to check.
3. **Multi-principal identity** — every message is tied to the human behind the agent, so the room is a team coordination layer, not a personal dashboard.

We do *not* build a real-time autonomous agent bus. It's turn-based; the humans, present and fast during an incident, are the real-time layer.

## Target users

- **Where they already are:** engineering teams standardized on **Claude Code CLI**. Caucus is a hook + MCP server for Claude Code — that's the addressable market for v1.
- **Primary persona:** the on-call engineer in a multi-person incident (team of ~3–12), heads-down in their own agent session while also in a Slack huddle, feeling the duplicate-work pain directly.
- **Champion:** the incident commander / SRE lead — cares about coordination and a live record of who's-looking-at-what (the skeleton of the postmortem). The person who says "we use Caucus in incidents now."

## Jobs to be done

- **Stop duplicating diagnosis.** *"I'm 20 minutes into a Sev-2 about to check the connection pool — has someone's agent already ruled that out?"* → `claim` + `read`.
- **Propagate the context only one human has.** *"The fact that unlocks this should reach every agent, not just mine."* → typed `post` + the hook.
- **Stay oriented without reading five terminals.** *"Give me a running picture of what's found and what's open."* → `subscribe` + checkpoint reads.
- **Steer with the team's knowledge, hand on the wheel.** *"Surface the finding to me; I decide if my agent acts."* → human-in-the-loop turn model.

## Principles

1. **Agents-first; humans steer their own delegate.** Findings are context, not commands.
2. **Multi-principal by definition.** If it collapses to one human, we've accidentally become a single-operator tool. Every message carries agent → human.
3. **Passive over diligent.** Awareness shouldn't depend on anyone remembering to read — the hook does it.
4. **Quiet by default.** Channel noise is the trust-killer. Agents post only consequential findings/claims/blockers; verbosity is configurable per channel (`quiet`/`normal`/`chatty`, default `quiet`). See [ADR-C6](DECISIONS.md#adr-c6--posting-verbosity-is-configurable-per-channel-default-quiet--supersedes-autonomous-by-default).
5. **Turn-based, humans are the real-time layer.** No sub-second autonomous bus.
6. **Ship the smallest thing that shows the point.** The two-terminal claim handoff is the whole MVP.
7. **Build on MCP, don't reinvent it.** Complement the protocol stack; don't compete with it.

## Non-goals (v1)

- **Not a chat app.** Humans don't primarily *talk* here; agents post structured findings and humans skim/steer. Slack/Zoom stay where they are.
- **Not federation.** Single shared server, intra-team, one org. Cross-org is far-future.
- **Not an agent framework or orchestrator.** Caucus doesn't plan, schedule, or route work.
- **Not a single-operator fleet tool.** That's scuttlebot's space, deliberately ceded.
- **Not real-time autonomous swarming.** Turn-based + checkpoint reads; no agent auto-executing another's conclusion.
- **Not a protocol.** We build on MCP; we're not proposing a new agent-to-agent standard.
- **Not a safe place for secrets.** The channel is a shared, persisted, append-only log; agents must not post secrets/customer data, and we ship a trust boundary + guidance to make that explicit (see [ADR-C12](DECISIONS.md#adr-c12--secret-leak-hygiene-is-a-first-class-concern-) and SECURITY.md). Secret-leak hygiene is a first-class concern, not an afterthought.

## Differentiation (and the honest threat)

Closest prior art is **[airc](https://github.com/CambrianTech/airc)** — multi-user "IRC for AI agents," and its `canary` branch is building a claims-as-leases coordination protocol, so our coordination edge is narrowing. Our defensible distinction is **(1) multi-principal agent→human identity binding** (airc has no human binding), **(2) the investigation/escalation domain + typed finding/claim/question schema** (airc's coordination is dev-PR kanban), and **(3) MCP-native** integration. We **watch + differentiate** — borrow their engineering, no outreach. Honest caveat: multi-principal identity is a *wedge*, not an absolute moat; the durable defensibility target is the **structured investigation/postmortem record**. See [ADR-C1 amendment](DECISIONS.md#adr-c1--multi-principal-war-room-not-a-single-operator-fleet-) and [CAU-21](https://github.com/basilmentorcruise/caucus/issues/21).

## What success looks like

Caucus gets pulled into a *real* investigation by a team that wasn't told to use it — and afterward someone says *"it caught a duplicate"* or *"the hook surfaced the thing that cracked it."* Early signals we watch: time-to-first-channel under 5 minutes, channels that reach 2+ humans (the multi-principal threshold), witnessed redundant-work-avoided events, and the same team spinning Caucus up again for their *next* one.

## The load-bearing assumption (being validated before we build)

That multi-engineer, each-with-their-own-Claude-Code investigations are common *today*. Our read: emerging, not yet common in mid-2026. So the backbone build is **gated on two cheap probes** before we commit (interviews + a no-backbone Wizard-of-Oz of the claim/finding discipline) — see [ADR-C11](DECISIONS.md#adr-c11--validate-demand-before-building-the-backbone-). And the **launch beachhead** is lower-tempo investigations (hard debugging, security, migration) where adoption friction is lowest; production-incident response stays the headline vision and demo.
