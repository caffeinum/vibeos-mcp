#!/bin/bash
# beads-tavc.17 — daily prod pairing canary wrapper. Runs the probe; on failure,
# DMs vibeos-ceo over the cotal mesh (paw dm). Scheduled by the launchd agent
# sh.vibeos.mcp.canary. Env knobs: CANARY_DRILL=1 labels the alert as a test;
# CANARY_RELAY overrides the relay (point at a dead url to prove the alert);
# CANARY_RETRY_DELAY overrides the transient-failure retry wait (default 30s).
set -uo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.vibeos-mcp/canary.log"
mkdir -p "$(dirname "$LOG")"
cd "$REPO" || exit 2

OUT=$(/opt/homebrew/bin/node canary/relay-canary.mjs 2>&1); CODE=$?

# Both pages so far were transient one-offs that cleared on a manual rerun minutes
# later with the relay Lambda clean (0 errors/throttles, concurrency ~2): 2026-10-22
# was a local DNS blip (connect-class), 2026-10-28 was "no tab schemas within 45s"
# (pairing-class) with Errors=0/Throttles=0 at the minute it fired (tavc.17). So
# retry the WHOLE pair probe once after a short wait before alerting, whatever the
# probe-failure reason (connect OR pairing OR a one-shot non-round-trip). A real
# break is sustained — it fails the retry too and still pages, ~30s later. The
# elevated-error-rate check reads a 3h window and is already a sustained signal, so
# it is NOT retried: a run that trips it pages on the first failure.
if [ "$CODE" -ne 0 ] && printf '%s' "$OUT" | grep -q 'pair probe:' && ! printf '%s' "$OUT" | grep -q 'error rate elevated'; then
  sleep "${CANARY_RETRY_DELAY:-30}"
  RETRY=$(/opt/homebrew/bin/node canary/relay-canary.mjs 2>&1); CODE=$?
  OUT=$(printf '%s\n--- transient pair-probe failure; retried after %ss ---\n%s' "$OUT" "${CANARY_RETRY_DELAY:-30}" "$RETRY")
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '[%s] exit=%s\n%s\n' "$TS" "$CODE" "$OUT" >> "$LOG"

if [ "$CODE" -ne 0 ]; then
  REASON=$(printf '%s' "$OUT" | grep -o 'CANARY FAIL:.*' | head -1)
  [ -z "$REASON" ] && REASON="canary exited $CODE: $(printf '%s' "$OUT" | tail -1)"
  PREFIX="🚨 vibeos MCP relay canary FAILED"
  [ "${CANARY_DRILL:-}" = "1" ] && PREFIX="🧪 [CANARY DRILL — ignore] vibeos MCP relay canary"
  paw dm vibeos-ceo "$PREFIX ($TS): $REASON — the bring-your-own-agent door may be down. Check CloudWatch Lambda vibeos-mcp-relay and run canary/run-canary.sh locally. (beads-tavc.17)" >> "$LOG" 2>&1
fi
exit "$CODE"
