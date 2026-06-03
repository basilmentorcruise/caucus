# CAU-24 SPIKE — Claude Code hook context-injection capability

**Ticket:** [CAU-24 / #24](https://github.com/basilmentorcruise/caucus/issues/24) · **Epic G — Pre-build validation** · Gates [CAU-14], pillar of [ADR-C3](../DECISIONS.md#adr-c3--integration-mcp-server--claude-code-hook).
**Status:** Complete · **Date:** 2026-06-03 · Claude Code `2.1.161`.

## Verdict

**GO.** A Claude Code **`UserPromptSubmit`** hook can fetch external data at **turn start** and inject it into the session context such that the model verifiably sees it, **every turn**, re-reading the external source each time. This satisfies ADR-C3's hook pillar — the passive-awareness primitive — with no fallback required.

**One-line mechanism:** register a `UserPromptSubmit` command hook that reads the channel delta from an external source and prints `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<rendered messages>"}}` to stdout (plain stdout also works); Claude Code adds that string to context alongside the user's prompt, on every turn.

## Hook event chosen: `UserPromptSubmit`

| Property | `UserPromptSubmit` (chosen) | `SessionStart` (rejected for the per-turn role) |
|---|---|---|
| Fires | **Every prompt = every turn** | Once per session (start/resume) |
| Injection mechanism | `additionalContext` (or plain stdout) added alongside the prompt | `additionalContext` / stdout added at conversation start |
| Re-reads external source each turn | **Yes** (empirically confirmed) | No — runs once |
| Fits ADR-C4 "catch up at turn start" | **Yes** | No (would miss every message after turn 1) |

`SessionStart` is the right place to do one-time setup (e.g. `subscribe`/cursor init), but the **turn-loop injection** in ADR-C3 maps to `UserPromptSubmit`. The two are complementary.

## Exact mechanism

### Config (`.claude/settings.json`)
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          { "type": "command", "command": "bash /ABSOLUTE/PATH/TO/caucus-hook.sh" }
        ]
      }
    ]
  }
}
```

### Output contract (two equivalent options)
1. **Structured (used here):** exit 0 and print JSON
   ```json
   {"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"...rendered messages..."}}
   ```
   Per the [hooks reference](https://code.claude.com/docs/en/hooks), `additionalContext` is "String added to Claude's context alongside the submitted prompt."
2. **Plain stdout:** exit 0 and just `echo` the text — "any non-JSON text written to stdout is added as context." Simpler, but JSON gives us future control fields (`decision`, `systemMessage`) for free.

The throwaway hook used here ([`cau-24-assets/caucus-hook.sh`](cau-24-assets/caucus-hook.sh)) reads "new messages" from an external file (standing in for `read_channel(since=checkpoint)`), wraps them in a delimited `=== CAUCUS CHANNEL ===` block, and emits option 1. On an **empty** source it emits nothing and exits 0 (matches ADR-C6 quiet-by-default).

## Demonstrated evidence (empirical, not docs-reading)

All runs are headless: `claude -p "<prompt>" --settings <scratch>/.claude/settings.json --allowedTools ""`, from an **isolated** `/tmp/cau24-spike` scratch dir (this repo's and `~/.claude` settings were untouched). Proof relies on **unguessable sentinel tokens** placed in the external feed — the model could only quote them if the hook actually delivered them.

### 1. Injection works — model quotes injected content verbatim
Feed contained a finding line with sentinel `CAUCUS-SENTINEL-9F3Q`. Prompt: *"What did the caucus hook inject... Quote the channel block verbatim, including any sentinel tokens."* Model replied:
```
=== CAUCUS CHANNEL (new since last turn) ===
[caucus] claim   A·alice  "auth-timeout repro"
[caucus] finding A·alice  /login accepts expired JWTs (signature not re-checked)  CAUCUS-SENTINEL-9F3Q
[caucus] note    C·carol  Human steer: check whether the 14:02 deploy correlates with the first 500s
=== END CAUCUS ===
```
> "The sentinel token present is `CAUCUS-SENTINEL-9F3Q`."

### 2. Per-turn firing with a fresh external read (the load-bearing proof for ADR-C3/C4)
Single resumed session, feed **changed between turns** to simulate new messages arriving:
- **Turn 1** (feed = original): asked for "ONLY the sentinel" → model replied `CAUCUS-SENTINEL-9F3Q`.
- Feed file overwritten with a new message carrying `CAUCUS-SENTINEL-TURN2-X7K2`.
- **Turn 2** (`--resume <same session>`): → model replied `CAUCUS-SENTINEL-TURN2-X7K2`.

The hook re-ran on turn 2 and injected the **newly-arrived** content — exactly the turn-loop behavior (`read_channel(since=checkpoint)` each turn). Commands run:
```bash
SID=$(uuidgen)
claude -p "Reply with ONLY the sentinel token..." --settings .../settings.json --session-id "$SID"   # -> CAUCUS-SENTINEL-9F3Q
printf '...CAUCUS-SENTINEL-TURN2-X7K2\n' > feed.txt
claude -p "Reply with ONLY the sentinel token this turn..." --settings .../settings.json --resume "$SID" # -> CAUCUS-SENTINEL-TURN2-X7K2
```

### 3. Quiet default — empty source injects nothing
Feed truncated to empty; hook exits 0 with no stdout. Prompt: *"Was there any caucus channel block injected this turn?"* → model: **"No."** No spurious context when there are no new messages.

### 4. Large payload reaches the model
A ~23 KB feed with sentinels at both the **start** (`CAUCUS-CAP-START-A1B2`) and **end** (`CAUCUS-CAP-END-Z9Y8`) of the block. Model confirmed **both** present and the block **not truncated**. (See "Limits" for the caveat on the documented cap.)

## Limits found

- **Per-prompt timeout: 30 s** for `UserPromptSubmit` `command` hooks (shorter than the 600 s default elsewhere) because it **blocks model processing every turn**. A stuck hook stalls the session. → Caucus's `read_channel` fetch must be fast and fail-open (on error/timeout, inject nothing rather than hang). Network calls are fine within budget; for this spike the external source was a file.
- **Documented output cap: 10,000 characters** for `additionalContext` / `systemMessage` / plain stdout. Per docs, output exceeding this is "saved to a file and replaced with a preview and file path." Empirically a 23 KB block was still **fully visible** to the model (both end sentinels intact), consistent with file-reference delivery rather than hard truncation — **but the exact >10 KB delivery path (inline vs file-reference) was not directly observed in debug output; treat the "23 KB fully delivered" result as observed behavior and the file-reference mechanism as inferred.** Either way, Caucus **caps the injected delta by design** (ADR-C3/C4 overflow → "+N older, call `read_channel`"), so we operate well under 10 KB and never depend on the overflow path.
- **Blocking semantics:** `UserPromptSubmit` can `decision:"block"` a prompt; we don't need that — injection is additive.
- **Plain stdout vs JSON:** both deliver context. JSON chosen for forward-compatible control fields and safe encoding (`jq -Rs` of arbitrary message text).
- **Network capability:** the event runs an arbitrary shell command, so it can `curl` a local backbone endpoint. Not exercised here (file source per spike scope); low risk given it's an ordinary subprocess.

## What was empirical vs inferred

- **Empirical:** injection visible to model (#1); per-turn re-firing with fresh external read across a resumed multi-turn session (#2); quiet/no-op on empty source (#3); 23 KB block fully delivered (#4); config format + headless invocation.
- **Inferred / from docs (flagged honestly):** the exact internal handling of `additionalContext` **above** the 10,000-char cap (file-reference preview) — observed effect (content reached model) but not the mechanism. **Follow-up:** if Caucus ever needs >10 KB single-turn injection (it shouldn't, given the delta cap), verify the file-reference path directly. Interactive (non-`-p`) turn-by-turn firing was demonstrated via headless `--resume`, which exercises the same `UserPromptSubmit` event; we did not separately drive the interactive TUI.

## Impact on ADR-C3 / the build

- **GO** for the hook pillar; the documented [ARCHITECTURE.md turn loop](../ARCHITECTURE.md#the-turn-loop) step 1–2 is implementable as a `UserPromptSubmit` command hook. No fallback needed.
- The `packages/hook` (CAU-14) hook should: read the cursor delta via the MCP/backbone, render per [MESSAGE_SCHEMA.md](../MESSAGE_SCHEMA.md#how-the-hook-renders-an-injected-message), cap to a size budget with the "+N older" overflow line, **fail-open within ~30 s**, and emit `UserPromptSubmit.additionalContext`. Cursor/subscribe init belongs in `SessionStart`.

## Fallback (designed, NOT needed)

Were per-turn `additionalContext` unavailable, the fallback is a **nudge**: the hook injects a single short line — `[caucus] N new messages — call read_channel to catch up.` — relying on the agent to call the MCP `read_channel` tool. Strictly worse (depends on the model choosing to act, the exact unreliability ADR-C3 cites), so it stays a contingency only. **The GO verdict means we ship full injection, not the nudge.**

## Reproduce

Assets in [`cau-24-assets/`](cau-24-assets/): `caucus-hook.sh` (throwaway hook), `settings.json` (hook config — set the absolute path to the script), `feed.example.txt` (sample external source).
```bash
mkdir -p /tmp/cau24-spike/.claude
cp docs/spikes/cau-24-assets/caucus-hook.sh /tmp/cau24-spike/
cp docs/spikes/cau-24-assets/feed.example.txt /tmp/cau24-spike/feed.txt
# write /tmp/cau24-spike/.claude/settings.json pointing command at /tmp/cau24-spike/caucus-hook.sh
cd /tmp/cau24-spike
claude -p "Quote the caucus block verbatim, including any sentinel tokens." \
  --settings /tmp/cau24-spike/.claude/settings.json --allowedTools ""
# expect the model to quote CAUCUS-SENTINEL-9F3Q
```
