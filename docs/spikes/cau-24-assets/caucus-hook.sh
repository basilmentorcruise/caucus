#!/usr/bin/env bash
# Throwaway CAU-24 spike hook: simulates the Caucus turn-start awareness hook.
# Reads "new messages" from an external source (a temp file standing in for
# read_channel(since=checkpoint)) and injects them into the session context
# via the UserPromptSubmit hook's additionalContext JSON field.
set -euo pipefail

SRC="${CAUCUS_FEED:-/tmp/cau24-spike/feed.txt}"

# Simulate fetching the new-since-checkpoint delta from an external source.
if [[ -f "$SRC" ]]; then
  MSGS="$(cat "$SRC")"
else
  MSGS=""
fi

if [[ -z "$MSGS" ]]; then
  # No new messages: emit nothing, exit 0 (quiet by default, ADR-C6).
  exit 0
fi

# Build the injected context block. jq -Rs slurps stdin as a raw JSON string,
# so arbitrary message text is safely encoded.
CONTEXT="$(printf '%s' "$MSGS" | jq -Rs '"=== CAUCUS CHANNEL (new since last turn) ===\n" + . + "\n=== END CAUCUS ==="')"

jq -n --argjson ctx "$CONTEXT" '{
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: $ctx
  }
}'
