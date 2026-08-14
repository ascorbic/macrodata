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
# a root drains the same mailbox, so two are always one too many. A worker
# serving a different root belongs to a different system and is never counted or
# reaped. Both facts are read off the worker's own argv, which is why it is
# spawned with a sentinel and a root it does not itself parse.
#
# That argv also says WHICH copy of the source a worker runs, since plugins
# install into a per-version directory:
#   1. this version's $WORKER          -> up, nothing to do
#   2. another version's plugin cache  -> stale after an upgrade; reap, respawn
#   3. anywhere else (a dev checkout)  -> a human started it deliberately, and
#      SessionStart fires on resume and compact as well as startup, so reaping
#      it would kill a debug worker mid-session. Leave it, spawn no competitor.
# Case 3 announces itself on stdout: that worker, not the installed release, is
# answering recall, and from the outside a worker serving code the release does
# not contain looks exactly like a healthy one.
#
# Spawned directly via nohup (no shell wrapper) so one logical process = one PID,
# which keeps the reap honest. Case 2 is reaped whole; if case 1 somehow has
# several, the lowest PID stays and the rest go — one source path means
# byte-identical code, so the choice among them is arbitrary. Detached procs
# persist after this script + the session exit.
#
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

# SIGTERM, then SIGKILL, then confirm. Nonzero if the process outlived both: an
# unverified reap logs a success while the old worker keeps draining the mailbox.
kill_verified() {
  local pid=$1 n=0
  kill "$pid" 2>/dev/null
  while [ "$n" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.1; n=$((n + 1)); done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null
    n=0
    while [ "$n" -lt 20 ] && kill -0 "$pid" 2>/dev/null; do sleep 0.1; n=$((n + 1)); done
  fi
  ! kill -0 "$pid" 2>/dev/null
}

# Reap a space-separated pid list; echoes back the ones still alive afterward.
reap() {
  local pid survivors=""
  # shellcheck disable=SC2086
  for pid in $1; do
    kill_verified "$pid" || survivors="$survivors $pid"
  done
  printf '%s' "$survivors"
}

# Snapshot first, filter second: a `ps | grep` pipeline can match its own grep,
# but a grep that starts after ps has exited cannot appear in ps's output.
# The sentinel and root are matched as one adjacent pair so that a checkout
# living inside some other root can't be mistaken for a worker serving it.
snapshot="$(ps -ww -eo pid=,command= 2>/dev/null || true)"

mine="" stale="" foreign=""
while read -r pid cmd; do
  case "$cmd" in
    *"$WORKER"*) mine="$mine $pid" ;;
    */plugins/cache/*src/recall/worker.ts*) stale="$stale $pid" ;;
    *) foreign="$foreign $pid" ;;
  esac
done < <(printf '%s\n' "$snapshot" | grep -F -- "$SENTINEL $ROOT")

# A worker from another plugin version runs code no live session asked for, so
# it goes regardless of what else is up.
if [ -n "$stale" ]; then
  log "worker: stale plugin-cache worker(s)$stale -> reap"
  survived="$(reap "$stale")"
  [ -n "$survived" ] && log "worker: reap FAILED, survived SIGKILL:$survived"
fi

if [ -n "$foreign" ]; then
  log "worker: hand-started worker(s)$foreign up -> left alone; $WORKER is not serving recall"
  echo "macrodata-recall: recall is served by a hand-started worker (pid${foreign}), not the installed plugin"
elif [ -n "$mine" ]; then
  # shellcheck disable=SC2086
  ordered="$(printf '%s\n' $mine | sort -n)"
  keep="$(printf '%s\n' "$ordered" | head -1)"
  extras="$(printf '%s\n' "$ordered" | tail -n +2 | tr '\n' ' ')"
  if [ -n "${extras// /}" ]; then
    log "worker: duplicates -> keep $keep, reap $extras"
    survived="$(reap "$extras")"
    [ -n "$survived" ] && log "worker: reap FAILED, survived SIGKILL:$survived"
  else
    log "worker: up (pid $keep)"
  fi
else
  log "worker: down -> starting"
  ( cd "$PLUGIN_ROOT" && nohup bun run "$WORKER" "$SENTINEL" "$ROOT" >> "$LOGDIR/worker.log" 2>&1 & )
fi

log "pass complete"
