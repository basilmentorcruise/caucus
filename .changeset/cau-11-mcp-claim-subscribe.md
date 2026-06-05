---
"@caucus/mcp-server": patch
---

CAU-11: add the `caucus_claim` (first-write-wins ownership; granted vs already_claimed surfaced verbatim, never as an error) and `caucus_subscribe` (mint a "now" cursor for delta reads; unknown channel fails loudly) MCP tools.
