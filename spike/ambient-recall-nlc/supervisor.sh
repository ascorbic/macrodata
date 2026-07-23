#!/usr/bin/env bash
# Ensure-up + reap supervisor for the ambient-recall spike (-nlc variant).
#
# Run by the SessionStart hook. Converges to EXACTLY ONE running instance of
#   - worker  bun run worker.ts   (drains .recall-request-*, writes .recall-inbox-*)
# then exits. The llama-servers (:8091 embed, :8090 rerank) are GONE — the
# worker owns the models in-process via node-llama-cpp (models.ts, lazy load).
#
# Ownership: the worker is matched on this dir's ABSOLUTE script path, so the
# plain-spike variant's worker (or any other bun worker.ts) is invisible here
# and can never be counted or reaped.
#
# Spawned directly via nohup (no shell wrapper) so one logical process = one PID,
# which keeps the reap honest. Reap rule: if >1 of ours, keep the lowest PID and
# kill the rest. Detached procs persist after this script + the session exit.
# Logs → .{supervisor,worker}.log (gitignored). Silent on stdout.
set -u
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
log() { echo "[$(date '+%F %T')] $*" >> "$DIR/.supervisor.log"; }

ensure() { # name  pgrep-pattern  -- start-cmd...
  local name="$1" pat="$2"; shift 2
  local pids; pids="$(pgrep -f "$pat" 2>/dev/null || true)"
  local n; n="$(printf '%s\n' "$pids" | grep -c '[0-9]')"
  if [ "$n" -eq 0 ]; then
    log "$name: down -> starting"
    ( cd "$DIR" && nohup "$@" >> "$DIR/.$name.log" 2>&1 & )
  elif [ "$n" -gt 1 ]; then
    local keep extras
    keep="$(printf '%s\n' "$pids" | sort -n | head -1)"
    extras="$(printf '%s\n' "$pids" | sort -n | tail -n +2 | tr '\n' ' ')"
    log "$name: $n instances -> reap (keep $keep, kill $extras)"
    # shellcheck disable=SC2086
    kill $extras 2>/dev/null || true
  else
    log "$name: up (pid $pids)"
  fi
}

ensure worker "bun run ${DIR}/worker\.ts" \
  bun run "$DIR/worker.ts"

log "pass complete"
