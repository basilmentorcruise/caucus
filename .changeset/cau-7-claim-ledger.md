---
"@caucus/backbone-server": patch
---

CAU-7 — Claim ledger over HTTP (first-write-wins).

- `POST /channels/:channel/claim` now serves the real claim handler (it returned
  a `501 not_implemented` stub before). Both outcomes are normal `200`
  `ClaimResult`s: `granted` (the claim message is appended in the same atomic
  step, ADR-C5) and `already_claimed` (the conflict carries `by: { agent_id,
  owner, ts, msg_id }`). A lost race is a **result, not an error** — the route
  never returns a `4xx`/`5xx` for a conflict. A non-object body is rejected with
  a structural `400 invalid_request`; validation/not-found failures still flow
  through the centralized error mapper (`invalid_message`, `unknown_channel`).
- The backbone (`InMemoryBackbone.claim`) is unchanged — this is the missing
  transport piece only. No lease expiry / release / reassignment (CAU-18, M2).
