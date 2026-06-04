---
"@caucus/schema": patch
"@caucus/backbone-server": patch
---

CAU-6 — Append-only log + read-since cursors hardening.

- Backbone HTTP transport: `POST /channels` and `POST /channels/:c/append` now
  reject a missing or non-object request body with a typed `invalid_request`
  400 before reaching the backbone (previously a raw `TypeError` surfaced as a
  generic 500). `POST /channels/:c/read` keeps coercing a missing body to `{}`
  (→ `invalid_cursor`) but rejects a present-but-non-object body the same way.
  The backbone remains the single semantic-validation authority.
- Schema validation caps the unbounded unknown-field issue list at
  `MAX_REPORTED_ISSUES` named fields plus one "…and N more unknown fields"
  summary, so a body packed with unknown keys can no longer inflate the
  validation error far beyond the offending body.
