#!/bin/bash
# beads-tavc.17 — daily prod pairing canary wrapper. Runs the probe; on failure,
# DMs vibeos-ceo over the cotal mesh (paw dm). Scheduled by the launchd agent
# sh.vibeos.mcp.canary. Env knobs: CANARY_DRILL=1 labels the alert as a test;
# CANARY_RELAY overrides the relay (point at a dead url to prove the alert);
# CANARY_RETRY_DELAY overrides the transient-failure retry wait (default 30s).
# The scheduled run first fast-forwards main to origin/main when safe (self-update
# below); a drill (CANARY_DRILL=1) or a CANARY_RELAY override skips that and never
# touches git.
set -uo pipefail
export PATH="/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.vibeos-mcp/canary.log"
mkdir -p "$(dirname "$LOG")"
cd "$REPO" || exit 2

# Who invoked us (launchd vs the operator's paw-cron vs a manual run) and when, so the
# log says which scheduler won the lock and how long the run took. $PPID survives the
# self-update exec (same pid/parent), so a re-exec recomputes the same invoker.
START=$(date +%s)
INVOKER=$(ps -o comm= -p "$PPID" 2>/dev/null | sed 's#^.*/##' | tr -d ' '); : "${INVOKER:=?}"

# Single-instance guard: two schedulers fire this canary at the same minute (the
# launchd agent at 11:37 local AND the operator's paw-cron "37 11 * * *"). Concurrent
# runs race on the npm/npx cache and the git index lock and can hang past the cron's
# 600s cap (seen 2026-10-29 and 2026-11-10); a lone run is ~25s. Take an atomic lock
# on first entry so the second concurrent run exits cleanly with no page. Steal a lock
# older than 15 min — a run killed at the 600s cap can't run its cleanup trap. The lock
# is HELD across the self-update re-exec: the re-exec carries CANARY_SELF_UPDATED, so
# it neither re-takes nor (via exec, which skips the trap) releases it early.
LOCK="$HOME/.vibeos-mcp/canary.lock"
if [ -z "${CANARY_SELF_UPDATED:-}" ]; then
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +15 2>/dev/null)" ]; then
      rmdir "$LOCK" 2>/dev/null
      mkdir "$LOCK" 2>/dev/null || { printf '[%s] skipped: lock contended (via %s)\n' "$(date -u +%FT%TZ)" "$INVOKER" >> "$LOG"; exit 0; }
    else
      printf '[%s] skipped: lock held, another run won (via %s)\n' "$(date -u +%FT%TZ)" "$INVOKER" >> "$LOG"
      exit 0  # another run is in progress
    fi
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Self-update (once per run): the launchd job runs this script straight from the dev
# checkout, so a merged canary fix would otherwise sit unused until a manual pull
# (beads-tavc.17). Fast-forward main to origin/main when it is SAFE — only on a clean
# main (never switching branches or touching uncommitted/untracked work) and only a
# fast-forward (never a merge/reset that could clobber). Non-fatal: if the fetch fails
# (e.g. no ssh-agent under launchd) the present version runs anyway. Then re-exec once
# (guarded by CANARY_SELF_UPDATED) so bash can't execute a half-rewritten script.
if [ -z "${CANARY_SELF_UPDATED:-}" ] && [ -z "${CANARY_RELAY:-}" ] && [ "${CANARY_DRILL:-}" != "1" ]; then
  export CANARY_SELF_UPDATED=1
  if BR=$(git symbolic-ref --short -q HEAD) && [ "$BR" = "main" ] \
     && git diff --quiet && git diff --cached --quiet; then
    # fail fast, never prompt/hang: BatchMode + ConnectTimeout bound the ssh dial,
    # GIT_TERMINAL_PROMPT=0 blocks credential prompts. A hang here would stall the
    # whole canary (the operator's paw-cron caps a run at 600s).
    GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND='ssh -o BatchMode=yes -o ConnectTimeout=10' \
      /opt/homebrew/bin/timeout 30 git fetch -q origin main 2>/dev/null \
      && git merge --ff-only -q origin/main 2>/dev/null || true
  fi
  exec /bin/bash "$0" "$@"
fi

# Hard-bound the probe (a lone probe is ~25s; its own deadlines sum to <90s). A kill
# at 150s surfaces as a non-zero exit the retry/alert path handles, so a true hang
# pages instead of silently burning the cron's 600s cap.
OUT=$(/opt/homebrew/bin/timeout 150 /opt/homebrew/bin/node canary/relay-canary.mjs 2>&1); CODE=$?

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
  RETRY=$(/opt/homebrew/bin/timeout 150 /opt/homebrew/bin/node canary/relay-canary.mjs 2>&1); CODE=$?
  OUT=$(printf '%s\n--- transient pair-probe failure; retried after %ss ---\n%s' "$OUT" "${CANARY_RETRY_DELAY:-30}" "$RETRY")
fi

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '[%s] exit=%s via=%s dur=%ss\n%s\n' "$TS" "$CODE" "$INVOKER" "$(( $(date +%s) - START ))" "$OUT" >> "$LOG"

if [ "$CODE" -ne 0 ]; then
  REASON=$(printf '%s' "$OUT" | grep -o 'CANARY FAIL:.*' | head -1)
  [ -z "$REASON" ] && REASON="canary exited $CODE: $(printf '%s' "$OUT" | tail -1)"
  PREFIX="🚨 vibeos MCP relay canary FAILED"
  [ "${CANARY_DRILL:-}" = "1" ] && PREFIX="🧪 [CANARY DRILL — ignore] vibeos MCP relay canary"
  paw dm vibeos-ceo "$PREFIX ($TS): $REASON — the bring-your-own-agent door may be down. Check CloudWatch Lambda vibeos-mcp-relay and run canary/run-canary.sh locally. (beads-tavc.17)" >> "$LOG" 2>&1
fi
exit "$CODE"
