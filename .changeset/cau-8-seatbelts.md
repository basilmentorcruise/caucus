---
"@caucus/backbone": patch
"@caucus/backbone-server": patch
---

CAU-8: seatbelts (ADR-C8). The backbone now enforces a per-agent posts/minute cap (sliding window) and consecutive loop/duplicate detection on the append path, throwing the new `RateLimitedError` (actionable message + `retryAfterMs`) and `DuplicatePostError` (body-free) — both safe to surface to the agent (ADR-C12). Claims rate-limit-check before the first-write-wins critical section and only charge budget on a granted write (a losing `already_claimed` consumes none); claims are not dup-checked. `InMemoryBackbone` takes optional `SeatbeltOptions` (cap / window / injectable clock; defaults never throttle normal traffic). The HTTP server maps `rate_limited`→429 and `duplicate_post`→409 and the client reconstructs both.
