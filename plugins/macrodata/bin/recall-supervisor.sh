#!/usr/bin/env bash
# Ensure-up + reap supervisor for the ambient-recall worker.
#
# Run by the SessionStart hook. Converges to EXACTLY ONE running instance of
#   - worker  bun run src/recall/worker.ts   (drains request-*, writes inbox-*)
# then exits. The worker owns the embed/rerank models in-process via
# node-llama-cpp (src/recall/models.ts, lazy load) — there are no llama-server
# side processes.
#
# Ownership is scoped to the STATE ROOT, not to a checkout: every worker sharing
# a root drains the same mailbox, so a second one is a duplicate whichever copy
# of the source it came from — including the copy the previous plugin version
# left running, since plugins install into a per-version directory. A worker
# serving a different root belongs to a different system and is never counted or
# reaped. Both facts are read off the worker's own argv, which is why it is
# spawned with a sentinel and a root it does not itself parse.
#
# Spawned directly via nohup (no shell wrapper) so one logical process = one PID,
# which keeps the reap honest. Reap rule: if >1 of ours, keep the lowest PID and
# kill the rest. Detached procs persist after this script + the session exit.
# Logs go under the state root's .recall/ beside the rest of the runtime state,
# NOT beside the source: the plugin installs into a per-version cache dir, so a
# source-relative log would be orphaned by every release. Silent on stdout while
# it works — SessionStart hook stdout is injected into the model's context — but
# a failure to start prints one line there, because nothing else reports it and
# the symptom is otherwise indistinguishable from "recall found nothing."
set -u
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
WORKER="$PLUGIN_ROOT/src/recall/worker.ts"

# Marks our workers in `ps`. Matched as a fixed string, so it must stay free of
# characters a regex or glob would treat as special.
SENTINEL="--macrodata-recall-worker"

ROOT="$(bun run "$PLUGIN_ROOT/bin/recall-print-root.ts" 2>/dev/null)"
if [ -z "$ROOT" ]; then
  echo "macrodata-recall: could not resolve the macrodata state root; ambient recall is NOT running"
  exit 0
fi

LOGDIR="$ROOT/.recall"
if ! mkdir -p "$LOGDIR" 2>/dev/null; then
  echo "macrodata-recall: cannot create $LOGDIR; ambient recall is NOT running"
  exit 0
fi
log() { echo "[$(date '+%F %T')] $*" >> "$LOGDIR/supervisor.log"; }

# Snapshot first, filter second: a `ps | grep` pipeline can match its own grep,
# but a grep that starts after ps has exited cannot appear in ps's output.
# The sentinel and root are matched as one adjacent pair so that a checkout
# living inside some other root can't be mistaken for a worker serving it.
snapshot="$(ps -ww -eo pid=,command= 2>/dev/null || true)"
pids="$(printf '%s\n' "$snapshot" | grep -F -- "$SENTINEL $ROOT" | awk '{print $1}')"
n="$(printf '%s\n' "$pids" | grep -c '[0-9]')"

if [ "$n" -eq 0 ]; then
  log "worker: down -> starting"
  ( cd "$PLUGIN_ROOT" && nohup bun run "$WORKER" "$SENTINEL" "$ROOT" >> "$LOGDIR/worker.log" 2>&1 & )
elif [ "$n" -gt 1 ]; then
  keep="$(printf '%s\n' "$pids" | sort -n | head -1)"
  extras="$(printf '%s\n' "$pids" | sort -n | tail -n +2 | tr '\n' ' ')"
  log "worker: $n instances -> reap (keep $keep, kill $extras)"
  # shellcheck disable=SC2086
  kill $extras 2>/dev/null || true
else
  log "worker: up (pid $pids)"
fi

log "pass complete"
