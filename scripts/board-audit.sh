#!/usr/bin/env bash
# agent-os — board-audit: prove the GitHub Project board is the source of truth.
# Flags issues that are OFF the board, or whose Status is INCONSISTENT with their real state:
#   - any open/closed issue not present as a project item            -> OFF-BOARD
#   - a closed issue whose Status is not Done                        -> STALE (should be Done)
#   - an open issue with an open linked PR whose Status is Todo      -> STALE (should be In Progress)
# Exits non-zero if any problem is found, so the coordinator can treat a clean run as evidence.
#
# Usage:  scripts/board-audit.sh <project-number> [owner]
#   owner defaults to the current repo's owner. Run inside the target git repo. Requires: gh, python3.
set -euo pipefail

PROJECT="${1:?usage: board-audit.sh <project-number> [owner]}"
OWNER="${2:-$(gh repo view --json owner -q .owner.login)}"

# Issues (open + closed) and which issue numbers have an open PR (heuristic: PR closes #N).
# Limits are high ceilings so a normal backlog is never truncated; bump if a repo exceeds them
# (gh would otherwise silently page, which would make the audit under-report).
ISSUE_LIMIT=2000   # max issues to audit in one pass
PR_LIMIT=1000      # max open PRs to scan for "closes #N" links
issues_json="$(gh issue list --state all --limit "$ISSUE_LIMIT" --json number,state,title)"
pr_json="$(gh pr list --state open --limit "$PR_LIMIT" --json number,body,headRefName)"
items_json="$(gh project item-list "$PROJECT" --owner "$OWNER" --limit "$ISSUE_LIMIT" --format json)"

ISSUES="$issues_json" PRS="$pr_json" ITEMS="$items_json" PROJECT="$PROJECT" python3 - <<'PY'
import json, os, re, sys

issues = json.loads(os.environ["ISSUES"])
prs    = json.loads(os.environ["PRS"])
items  = json.loads(os.environ["ITEMS"]).get("items", [])

# issue numbers referenced by an open PR body ("closes #12", "fixes #12", etc.)
open_pr_issues = set()
for pr in prs:
    for m in re.findall(r"(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)", (pr.get("body") or ""), re.I):
        open_pr_issues.add(int(m))

# map issue number -> Status on the board
board = {}
for it in items:
    c = it.get("content") or {}
    if c.get("type") == "Issue" and "number" in c:
        board[int(c["number"])] = (it.get("status") or "").strip()

problems = []
for iss in issues:
    n, state = int(iss["number"]), iss["state"].upper()
    title = iss["title"]
    if n not in board:
        problems.append(f"OFF-BOARD  #{n} ({state}) — {title}")
        continue
    status = board[n]
    if state == "CLOSED" and status != "Done":
        problems.append(f"STALE      #{n} closed but Status='{status or 'none'}' (expected Done) — {title}")
    elif state == "OPEN" and n in open_pr_issues and status in ("", "Todo"):
        problems.append(f"STALE      #{n} has an open PR but Status='{status or 'none'}' (expected In Progress) — {title}")

if problems:
    print("BOARD AUDIT FAILED:")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print(f"OK: {len(issues)} issues, all on board #{os.environ.get('PROJECT','?')} with consistent Status.")
PY
