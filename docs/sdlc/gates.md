# Gate protocol, circuit-breaker & the verified Definition of Done

The gate sequence, the unified verdict schema, how the coordinator routes verdicts, the circuit-breaker, and the
verified DoD. The narrative loop is in `SDLC.md`; the roster is in `GOVERNANCE.md`.

## Gate sequence (per ticket)
```
code-reviewer → architect (post-impl review) → security → qa (per-ticket) → release-coordinator (SHIP/HOLD)
```
Designer's design-review runs for UI tickets (alongside code-review). Upstream "readiness" gates
(vision-clarity, roadmap-readiness, ticket-readiness, design-readiness, threat-model) are entry conditions, not
PR gates — they must be satisfied before the work they guard begins.

## Unified verdict schema
Every quality gate returns:
```
gate: <name> · ticket: #<n>
verdict: PASS | FAIL | BLOCKED
reasons: [...]      # required unless PASS
evidence: [...]     # file:line, command output, coverage report, artifact links
```
The **release** gate is the one exception by design: it returns `SHIP | HOLD | BLOCKED` (a final go/no-go, not a
quality verdict).

## Coordinator routing
- `PASS` → advance to the next gate.
- `FAIL` → route back to **developer** with `reasons`; increment the ticket's attempt counter.
- `BLOCKED` → open a `needs-attention` issue with full history (external/missing dependency, e.g. an absent E2E fixture).
- **The coordinator verifies before acting** — it re-confirms CI (`gh pr checks`), board Status, docs diff, and
  that the E2E actually ran. A claimed-but-unverifiable `PASS` is treated as not done.

## Iterative review (gates re-review every push)
A gate that returns `FAIL` is re-dispatched after the developer pushes a fix: it **re-reviews the updated PR** and
**verifies each prior finding is actually resolved** (verify-don't-assume), carrying forward the running findings
list. A gate `PASS`es only when no must-fix/blocking findings remain. The code-review gate judges the PR against
the **acceptance criteria + the architect's plan**, not the diff in isolation.

## Circuit-breaker (progress-aware; the only stop in autopilot)
Keep iterating while the developer makes progress. Trip the breaker when the **same unresolved finding persists 3
rounds** (no progress): stop retrying → open a `needs-attention` issue containing the gate history + last verdict,
label the ticket `blocked`, and move the loop to other eligible work. Genuine progress (new/changed findings)
resets the count. No other human approval gates exist; escalations also arise from progress-review big pivots (→
planner) and `BLOCKED` verdicts.

## Verified Definition of Done

### Ticket DoD (before merge)
- All Given/When/Then ACs met, each covered by a real, behavior-asserting test (qa).
- Coverage meets the gate (≥80–85% line+branch on business logic), read from the actual report (architect/qa).
- All gates `PASS`: code-review, architecture, security, qa — verified, not assumed.
- CI green on the PR (`gh pr checks`); branch up to date with `main`.
- No open `must-fix` / `Critical` / `High`.
- README/STATUS/docs updated in the PR when behavior/interface/config/setup changed (code-review must-fix).
- Ticket on the board with the correct Status.

### Epic DoD (before release)
- Every ticket merged and individually Done.
- **The real-app/system E2E has actually run and passed** (qa) — scripted ACs + adversarial pass, real data,
  sandbox third-parties. A missing app/fixture → `BLOCKED`; the epic stays open. **Coverage/unit green ≠ Done.**
- docs comprehensive pass landed (README/STATUS reflect shipped capabilities), verified by the coordinator.
- release-coordinator cut the tagged release + changelog; deploy done or explicitly deferred.
- progress-reviewer has reviewed progress and filed any warranted corrections.
