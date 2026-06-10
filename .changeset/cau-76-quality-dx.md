---
"@caucus/backbone": minor
---

CAU-76 — remove the dead `dupWindow` knob from `SeatbeltOptions` (and the
`DEFAULT_DUP_WINDOW` export). The option was read and discarded: loop/duplicate
detection always compares only the immediately-previous post (N=1), so the knob
configured nothing. Widening the window is a future feature that will grow a
real option when it ships. The claim atomicity invariant (no `await` between
the ledger read and write in `claim()`) is now enforced by an automated
source-level guard test instead of living only in a comment.
