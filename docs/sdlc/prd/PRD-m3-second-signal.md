# PRD — M3: Second Signal & operational truth

> **This is an EVIDENCE milestone, not a feature milestone.** Caucus is over-built relative to demonstrated demand. M3's job is to *earn the next demand signal* and make the shipped system honest under real multi-machine use — not to add surface area. A clean internal repeat of the first dogfood is a **RED FLAG**, not a pass.

## Problem & users

`@caucus/*@0.2.0` is live on npm and passed a real-services QA sweep. But every demand signal to date is internal (CAU-85 + the coming CAU-127 are *us* dogfooding). Meanwhile, **Claude Code shipped "Agent Teams" (Feb 2026)** — shared task list + self-claim + P2P mailbox for 2–16 agents — which commoditizes the *AI↔AI coordination* half of Caucus on a **single machine, single operator, AI-to-AI** basis. This both threatens Caucus and sharpens its boundary: Caucus is **many humans, each owning one agent, across machines, producing a typed investigation record** — a thing Agent Teams structurally cannot express (no human-identity binding, single-machine).

Two consequences: (1) we must *prove* the surviving differentiators matter to a real investigation, and (2) the moment we claim "multi-machine," the install path must not fail silently.

**Target users:**
- **Incident commander / SRE lead** — runs the war room, needs operational truth (who minted what, is everyone wired correctly) and a defensible investigation record.
- **Investigating engineers** — each runs their own Claude Code session on their own machine/working-tree; need claim-dedup, passive awareness, and cross-machine evidence sharing to actually pay off versus working solo.

## Core hypothesis under test

> When a real, harder-than-CAU-85 investigation is run **cross-machine with two distinct human identities**, Caucus's surviving differentiators — (1) multi-principal agent→human anchored identity, (2) cross-machine/cross-working-tree coordination, (3) the typed investigation/postmortem record — deliver value that a single-operator Agent-Teams setup **structurally cannot**, AND the harder run surfaces **≥3 net-new friction items** that become the real M3 build backlog.

If the run instead cleanly re-confirms GO with no new friction, that is a **demand-plateau signal** (red flag), not a victory — it means we are dogfooding a mature toy and the next move is external pull or a strategic pause, not more feature build.

## Goals / non-goals

**Goals**
- Run a second dogfood deliberately harder than CAU-85 along the two untested axes: **evidence-heavy + cross-repo/working-tree**, and **two real machines / two distinct human identities**.
- Make the verdict explicitly answer the **Agent-Teams contrast**: "what did Caucus give us that a single-operator agent team would not?"
- Hit a measurable success bar (≥3 net-new frictions OR external pull; see metrics).
- Close the two confirmed operational-truth debts (control-plane audit trail, admin CLI) regardless of the verdict.
- Give operators a preflight (`caucus doctor`) so the multi-machine install path fails loud, not silent.
- Produce decisive resolutions for the parked viewer (CAU-118) and the friction backlog (CAU-131), grounded in verdict evidence.
- Ship cheap, urgent **positioning** (Caucus vs Agent Teams) + a cross-machine quickstart while the contrast is fresh.

**Non-goals (locked by ADR)**
- No federation / cross-org / multi-server (ADR-C9).
- No native real-time SDK (ADR-C4, CAU-16 deferred).
- No auth platform / external token formats (JWT/OAuth/PKI) (ADR-C7).
- No durable/persisted store, including a persisted audit log (ADR-C2; ADR-C14).
- No secret-scanning-as-a-blocker (vision-guard tests only, not a merge gate).
- No Agent-Teams *interop* in M3 (positioning/contrast only; interop is Later, ADR-gated).
- No web viewer *build* in M3 (CAU-130 decides its fate; it does not build it).

## Requirements

**Functional**
- F1. A harder second dogfood runs end-to-end across two separate working directories/processes, exercising claim, finding, hook injection cross-session, typed steer session→session, and an evidence artifact fetched by the *other* session from a different working dir.
- F2. The run includes an explicit **Agent-Teams-contrast design**: two distinct human identities (distinct `owner` per token), cross-machine, and a verdict section that names what Caucus delivered that a single-operator agent team could not.
- F3. The verdict records go/deepen/kill with evidence and **enumerates net-new friction items** (count is a first-class output).
- F4. Every issuer mint/revoke/rotate emits one structured, secret-free stderr audit line.
- F5. `caucus` CLI wraps issuer mint/revoke/rotate over the existing loopback admin routes.
- F6. `caucus doctor` verifies a fresh machine's wiring and prints actionable, value-free diagnostics.
- F7. CAU-118's park is resolved decisively on verdict evidence (unpark+AC+ADR-prereq, or stay parked with sharper trigger).
- F8. CAU-131 is split into ≤2 concrete tickets from confirmed friction only.
- F9. Public positioning: a "Caucus vs Agent Teams" page + a runnable cross-machine quickstart.

**Non-functional**
- NF1. **Secret hygiene (ADR-C12):** no audit line, CLI output, doctor output, or error contains plaintext tokens, the admin token, or reconstructable bytes. Tested by minting known bytes and grepping captured output.
- NF2. **Quiet-by-default (ADR-C6):** control-plane events go to stderr only; doctor's auth check posts nothing to the war-room log; stdout discipline on the hook path is regression-guarded.
- NF3. **Trust boundary unchanged (ADR-C9/C7):** no new server capability, no new auth boundary; admin token read from env only.
- NF4. **Coverage gate:** 90% on all four metrics; integration harness (real subprocesses) green. CAU-127 is `type:spike`, coverage-exempt (deliverable is a written verdict).

## UX notes (CLI + docs)

- CLI errors are actionable and value-free: name the failed check and the fix, never echo a token. Minted token printed **once** to stdout with a "copy now, not re-readable" warning.
- `caucus doctor` output reads as a checklist (URL reachable / token authorizes / hook installed + stdout-clean / channel joinable / clock sane), pass-green/fail-named, exit 0 vs non-zero.
- Positioning page leads with the boundary table (single-machine/single-operator/AI-to-AI **vs** cross-machine/multi-human/anchored-identity/investigation-record), then the cross-machine quickstart a reader can actually run.

## Success metrics (make the bar concrete)

The milestone **passes** iff at least one of:
- **(A) External pull** — a team we did not instruct pulls Caucus into a real investigation (the true second signal). *Or*
- **(B) ≥3 net-new friction items** surfaced by a *genuinely harder* CAU-127 (cross-machine + two human identities + evidence-heavy), each concrete enough to become a ticket, AND a written Agent-Teams-contrast answer that names ≥1 capability Caucus delivered that a single-operator agent team could not.

The milestone is **flagged (red, owner decision required)** if:
- **(C) Clean internal repeat** — CAU-127 re-confirms GO with **<3 net-new frictions and no external pull**. This is a demand-plateau signal: the owner decides hardening-polish vs strategic pause. It is explicitly **not** counted as a pass.

Secondary (operational-truth, verdict-independent): CAU-128 + CAU-129 shipped and validated end-to-end; `caucus doctor` turns ≥3 distinct silent-misconfig modes into named, actionable failures.

## Edge cases & error states

- Admin token unset → control routes disabled → audit lines no-op (no crash); CLI/doctor exit non-zero with an actionable value-free message.
- Non-loopback admin call → rejected, value-free error.
- Revoked token → subsequent write rejected (validated end-to-end); doctor reports auth failure without posting.
- Two-machine run where evidence fetch *fails* across working dirs → that is a valid finding, recorded as friction (do not paper over it).
- CAU-127 returns deepen/kill/lukewarm → trips metric (C); do not advance CAU-130/131 as if GO.

## Open questions (owner forks — surface, do not resolve)

1. **CAU-127 scenario domain:** continue the #88/#90 sanitization tail (cheap continuity) or a different domain (migration/perf) to test breadth? Different domains validate a different adoption claim.
2. **"Two machines" fidelity:** loopback-simulated (cheap, safe, doesn't test real network exposure) vs controlled non-loopback (tests real identity/exposure posture but pushes on ADR-C9's single-loopback stance — may itself raise an ADR question).
3. **Pass definition:** does a clean internal-only CAU-127 count as a horizon pass? **Must be decided BEFORE #127 runs** — this PRD's stance is *no* (metric C = red flag); owner to ratify.
4. **External outreach (Ticket G):** is design-partner outreach in scope, given the project's no-outreach lean? Outreach is the *only* path to metric (A); flagged for owner go/no-go before G executes.

## Ticket breakdown

Reconciliation of #127–132 + two new tickets (F, G) — see the linked issues and the coordinator handoff. Execution order: build-now (no owner fork) vs verdict/owner-gated is specified in the handoff.
