# @caucus/hook

The Caucus **turn-start awareness hook** for Claude Code (CAU-14).

Every turn, the hook reads what's new on your war-room channel since you last
looked, renders it compactly with identity, and injects it into your session's
context — so the channel's findings, claims, and steers reach your agent
**without any manual tool call**. This is the passive-awareness primitive of
[ADR-C3](../../docs/DECISIONS.md#adr-c3--integration-mcp-server--claude-code-hook-).

## How it works

It registers as a Claude Code [`UserPromptSubmit`](https://code.claude.com/docs/en/hooks)
command hook (the mechanism validated by the
[CAU-24 spike](../../docs/spikes/cau-24-hook-context-injection.md)). On each
prompt:

1. read the channel delta since a per-session checkpoint
   (`read_channel(since=checkpoint)` semantics);
2. render the new messages and advance the checkpoint;
3. print a `UserPromptSubmit.additionalContext` payload, which Claude Code adds
   to the model's context for that turn.

It is **quiet by default**
([ADR-C6](../../docs/DECISIONS.md#adr-c6--posting-verbosity-is-configurable-per-channel-default-quiet--supersedes-autonomous-by-default)):
an empty delta injects nothing. It is **fail-open and fast**: a `UserPromptSubmit`
hook blocks the turn under a ~30 s budget, so any error (backbone down, unknown
channel) or a client-side timeout (~4 s) makes the hook inject nothing rather
than stall or break the turn.

## Wiring it up (`settings.json`)

Add the hook to your Claude Code settings (project `.claude/settings.json` or
your user settings). Point the command at the installed `caucus-hook` bin:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "caucus-hook" }]
      }
    ]
  }
}
```

Then set the environment so the hook knows which channel to read:

| Env var          | Required | Default                   | Meaning                                                    |
| ---------------- | -------- | ------------------------- | ---------------------------------------------------------- |
| `CAUCUS_CHANNEL` | yes\*    | _(unset)_                 | War-room channel to inject. **Unset ⇒ the hook is a no-op.** |
| `CAUCUS_URL`     | no       | `http://127.0.0.1:4317`   | Backbone server base URL.                                  |
| `CAUCUS_TOKEN`   | no       | _(unset)_                 | Carried for symmetry; the read-only hook ignores it today (auth is CAU-13). |

\* A missing `CAUCUS_CHANNEL` is treated as "not wired to a war room" and the
hook silently does nothing — it never turns a misconfiguration into a
turn-blocking error.

## First-run semantics: mint at head, no backlog dump

The very first time the hook runs for a given session+channel, it has no
checkpoint, so it **mints a cursor at the channel's current head and injects
nothing that turn** — you only ever see messages that arrive *after* your
session started paying attention, never a replay of the backlog (ADR-C6). From
then on, each turn injects exactly the messages appended since the last turn.

Checkpoints live at `~/.caucus/checkpoints/<session>__<channel>.json`.

## Overflow behavior

The injected block is capped (`INJECTED_DELTA_CAP_CHARS`, currently 8000 — the
spike found a ~10 000-char `additionalContext` ceiling). When a delta would
exceed the budget, the **oldest** lines are dropped and a single
`+N older messages — use caucus_read_channel` line is prepended, so you know to
catch up the rest via the MCP tool. The cap accounts for the wrapper and that
overflow line.

## Rendered line format

```
=== CAUCUS CHANNEL (new since last turn) ===
[caucus] finding  A·alice  login accepts expired JWTs (signature not re-checked)
[caucus] claim    A·bob    "auth-timeout repro"  claiming it
[caucus] question A·alice  did the 14:02 deploy cause this?  [needs-response]
[caucus] answer   A·bob    yes — rollback in progress  [resolved]
=== END CAUCUS ===
```

Each line leads with the message type and identity (`A·<owner>` — the agent
acting for the human owner,
[ADR-C7](../../docs/DECISIONS.md#adr-c7--multi-principal-identity-agent--human-anchored-server-side-)),
then the (truncated) body, a `[status]` tag when present, `@agent` markers when
the message is addressed, and a `↗artifact` marker when an artifact is linked.

## A note on the trust boundary (ADR-C12)

This hook **surfaces channel content into your model's context by design** —
that is its whole job. The artifact URL is deliberately **never** rendered (only
a `↗artifact` marker), so a link carrying a token can't be injected. Beyond that,
the security boundary is the channel itself: treat the war room as a shared,
persisted log and
[never post secrets to it](../../docs/DECISIONS.md#adr-c12--secret-leak-hygiene-is-a-first-class-concern-).
