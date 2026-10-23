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

# A resolver/connect hiccup (ENOTFOUND, EAI_AGAIN, refused/timed-out dial, a relay
# that never opened) is not the relay being down — the 2026-10-22 page was exactly
# that, a local DNS blip (tavc.17). Retry the whole probe once after a short wait
# before alerting. A real pairing regression ("no tab schemas", "did not
# round-trip") or an elevated error rate is NOT connect-class, so it still pages
# on the first failure.
if [ "$CODE" -ne 0 ] && printf '%s' "$OUT" | grep -Eq 'ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|getaddrinfo|relay unreachable|ws never opened|socket hang up'; then
  sleep "${CANARY_RETRY_DELAY:-30}"
  RETRY=$(/opt/homebrew/bin/node canary/relay-canary.mjs 2>&1); CODE=$?
  OUT=$(printf '%s\n--- transient connect failure; retried after %ss ---\n%s' "$OUT" "${CANARY_RETRY_DELAY:-30}" "$RETRY")
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
