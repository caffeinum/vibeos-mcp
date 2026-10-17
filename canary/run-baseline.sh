#!/bin/bash
# One-shot pre-HN baseline (beads-1vu7). Runs the agent-only/paired baseline
# query for 2026-10-17 and 2026-10-18, DMs vibeos-yc, then UNLOADS ITSELF so it
# fires exactly once. Scheduled by launchd agent sh.vibeos.mcp.baseline.
set -uo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.vibeos-mcp/baseline.log"
mkdir -p "$(dirname "$LOG")"
cd "$REPO" || exit 2

OUT=$(/opt/homebrew/bin/node canary/baseline-query.mjs 2>&1); CODE=$?
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '[%s] exit=%s\n%s\n' "$TS" "$CODE" "$OUT" >> "$LOG"

# self-destruct: run once, then remove the launchd agent so it never recurs
PLIST="$HOME/Library/LaunchAgents/sh.vibeos.mcp.baseline.plist"
launchctl unload "$PLIST" >> "$LOG" 2>&1
rm -f "$PLIST" >> "$LOG" 2>&1
exit "$CODE"
