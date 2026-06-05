---
"@caucus/backbone-server": patch
---

CAU-13: server-anchored identity — writes (`append`/`claim`/`createChannel`) require a bearer token from the server's `CAUCUS_TOKENS` map and the server overwrites the message's `agent_id`/`owner` from the resolved token (anti-forgery by construction; fail-closed when no tokens are configured). Reads stay open within the trust boundary. `HttpBackbone` gains a `token` option.
