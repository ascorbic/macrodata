#!/bin/bash
#
# Macrodata Local Hook Script
#
# Usage:
#   macrodata-hook.sh session-start  - Launch daemon, signal reload, converge the
#                                       ambient-recall worker, emit the first-run
#                                       onboarding nudge if unconfigured
#   macrodata-hook.sh prompt-submit  - Ensure the daemon and the recall worker are
#                                       up, inject any pending daemon-written
#                                       context
#   macrodata-hook.sh recall-worker  - Converge the recall worker alone
#   macrodata-hook.sh print-root     - Print the resolved state root
#
# Both long-lived processes macrodata owns — the daemon and the ambient-recall
# worker — are managed from here, on BOTH events. Running on every prompt is what
# makes an upgrade take effect: SessionStart fires on startup, resume, clear and
# compact, and a plugin update followed by a reload is none of those, so a manager
# registered only there serves the previous version's code until the human happens
# to open a new session.
#
# NOTE: session-start no longer composes the memory context here. Each state
# file is injected by its own compose-state-file.ts hook, journal+schedules by
# compose-lists.ts, USAGE by inject-usage.sh, and the files manifest by
# inject-files.sh — each in its own ~10K hook-output envelope (anthropics/
# claude-code#44086). This script only manages process lifecycles and the
# first-run nudge.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DAEMON="$SCRIPT_DIR/macrodata-daemon.ts"
RECALL_WORKER="$PLUGIN_ROOT/src/recall/worker.ts"

# Marks our recall workers in `ps`. Matched as a fixed string, so it must stay
# free of characters a regex or glob would treat as special.
RECALL_SENTINEL="--macrodata-recall-worker"

# State root (MACRODATA_ROOT > config.json > default)
DEFAULT_ROOT="$HOME/.config/macrodata"
CONFIG_FILE="$DEFAULT_ROOT/config.json"
if [ -n "$MACRODATA_ROOT" ]; then
    STATE_ROOT="$MACRODATA_ROOT"
elif [ -f "$CONFIG_FILE" ]; then
    STATE_ROOT=$(jq -r '.root // empty' "$CONFIG_FILE" 2>/dev/null)
    STATE_ROOT="${STATE_ROOT:-$DEFAULT_ROOT}"
else
    STATE_ROOT="$DEFAULT_ROOT"
fi

PIDFILE="$STATE_ROOT/.daemon.pid"
PENDING_CONTEXT="$STATE_ROOT/.pending-context"
PENDING_REMINDERS_DIR="$STATE_ROOT/.pending-reminders"
LOGFILE="$STATE_ROOT/.daemon.log"
IDENTITY="$STATE_ROOT/state/identity.md"
# Recall logs live under the state root beside the rest of the runtime state, NOT
# beside the source: the plugin installs into a per-version cache dir, so a
# source-relative log would be orphaned by every release.
RECALL_LOGDIR="$STATE_ROOT/.recall"
# Written by the worker itself (getWorkerPidPath in src/recall/config.ts), which
# claims it exclusively so a burst of spawns settles on one survivor. Liveness is
# still decided by `ps` here, never by this file.
RECALL_PIDFILE="$RECALL_LOGDIR/worker.pid"

# SIGTERM, then SIGKILL, then confirm. Nonzero if the process outlived both: an
# unverified reap logs a success while the old process keeps doing its job.
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
# Anything non-numeric is dropped rather than passed on: the list is built from
# `ps` output, and an unquoted word reaching `kill` would first be glob-expanded
# against the current directory.
reap() {
    local pid survivors=""
    # shellcheck disable=SC2086
    for pid in $1; do
        case "$pid" in ''|*[!0-9]*) continue ;; esac
        kill_verified "$pid" || survivors="$survivors $pid"
    done
    printf '%s' "$survivors"
}

# An announcement is injected into the model's context, so it arrives tagged like
# every other injected block. Bare prose there is indistinguishable from something
# the user wrote, which is the one reading that makes a worker warning actionable
# by the wrong party.
recall_announce() {
    printf '<macrodata-recall-status>\n%s\n</macrodata-recall-status>\n' "$1"
}

is_daemon_running() {
    if [ -f "$PIDFILE" ]; then
        local pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

# The PID recorded in the pidfile (nonzero exit if none / empty).
read_daemon_pid() {
    [ -f "$PIDFILE" ] || return 1
    local pid; pid=$(cat "$PIDFILE")
    [ -n "$pid" ] || return 1
    printf '%s' "$pid"
}

# argv of a SPECIFIC pid (empty + nonzero if it isn't alive). The PID file is
# version-agnostic (keyed to the state root), but $DAEMON is version-specific
# (its cache path contains the version), so the argv tells us which version is
# running. Callers pin the PID once via read_daemon_pid and pass it here, so the
# argv we classify and the PID we later signal/kill are the SAME process — never
# two reads of a mutable pidfile.
daemon_argv() {
    local pid=$1
    { [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; } || return 1
    ps -p "$pid" -o command= 2>/dev/null
}

start_daemon() {
    # Pin the PID once, then classify AND act on that same process — re-reading
    # the pidfile between the argv check and the kill could target a different
    # (recycled / just-respawned) process.
    local pid="" cmd=""
    pid=$(read_daemon_pid) || pid=""
    if [ -n "$pid" ]; then
        cmd=$(daemon_argv "$pid") || cmd=""
    fi
    if [ -n "$cmd" ]; then
        case "$cmd" in
            *"$DAEMON"*)
                # Current version already running — nothing to do.
                return 0
                ;;
            */plugins/cache/*macrodata-daemon.ts*)
                # A plugin-cache daemon from a DIFFERENT version: stale after an
                # upgrade (it keeps running the old cached code). Stop it so we
                # respawn from the new version path. (GH #12.)
                #
                # The escalation inside kill_verified is load-bearing here: a
                # daemon that ignores SIGTERM and survives leaves us spawning a
                # fresh one that immediately self-exits ("already running", since
                # the stale PID is still live), silently keeping the OLD code.
                kill_verified "$pid"
                # SIGKILL skips the daemon's own pidfile cleanup, so clear it
                # here — the fresh daemon must never read a stale entry.
                rm -f "$PIDFILE"
                ;;
            *)
                # Daemon running from outside the plugin cache (a hand-started
                # dev checkout). Assume it's intentional — leave it, don't spawn
                # a competitor. Restart it yourself if you're iterating on it.
                return 0
                ;;
        esac
    fi

    local BUN="bun"
    mkdir -p "$STATE_ROOT"
    # Daemon writes its own PID file; we don't write it here. stdin goes to
    # /dev/null because nohup redirects only stdout and stderr, and this process
    # outlives the hook whose stdin is the harness's session pipe.
    MACRODATA_ROOT="$STATE_ROOT" nohup "$BUN" run "$DAEMON" </dev/null >> "$LOGFILE" 2>&1 &

    # Wait briefly for the daemon to write its PID file (up to 2 seconds).
    local attempts=0
    while [ $attempts -lt 20 ]; do
        sleep 0.1
        if is_daemon_running; then
            return 0
        fi
        attempts=$((attempts + 1))
    done
    # Didn't report a PID in time — a cold `bun` start can exceed 2s. Leave a
    # breadcrumb instead of failing silently.
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] start_daemon: daemon did not report a PID within 2s" >> "$LOGFILE"
}

signal_daemon_reload() {
    # Guard against PID reuse: a stale pidfile can name a recycled PID now owned
    # by an unrelated process, and many programs treat SIGHUP as "terminate".
    # Pin the PID once and HUP that exact validated process — only if its argv
    # says it's a macrodata daemon.
    local pid cmd
    pid=$(read_daemon_pid) || return 0
    cmd=$(daemon_argv "$pid") || return 0
    case "$cmd" in
        *macrodata-daemon.ts*) kill -HUP "$pid" 2>/dev/null ;;
    esac
}

# supervisor.log keeps its name though recall-supervisor.sh is gone: this is the
# primary forensic record for recall-liveness incidents, and a rename would split
# the history across two files at the exact moment someone is reading back.
recall_log() { echo "[$(date '+%F %T')] $*" >> "$RECALL_LOGDIR/supervisor.log"; }

# Converge on EXACTLY ONE running ambient-recall worker, then return. The worker
# (src/recall/worker.ts) drains request-* and writes inbox-*, owning the embed and
# rerank models in-process via node-llama-cpp — there are no llama-server side
# processes.
#
# Ownership is scoped to the STATE ROOT, not to a checkout: every worker sharing a
# root drains the same mailbox, so two are always one too many. A worker serving a
# different root belongs to a different system and is never counted or reaped.
# Both facts are read off the worker's own argv, which is why it is spawned with a
# sentinel and a root it does not itself parse — the root there is a label for
# `ps`, and the worker resolves its real mailbox through getStateRoot() like every
# other entry point.
#
# That argv also says WHICH copy of the source a worker runs, since plugins install
# into a per-version directory:
#   1. this version's $RECALL_WORKER    -> up, nothing to do
#   2. another version's plugin cache   -> stale after an upgrade; reap, respawn
#   3. anywhere else (a dev checkout)   -> a human started it deliberately, and
#      this runs on every prompt, so reaping it would kill a debug worker
#      mid-session. Leave it, spawn no competitor.
#
# Spawned directly via nohup (no shell wrapper) so one logical process = one PID,
# which keeps the reap honest. Case 2 is reaped whole; if case 1 somehow has
# several, the lowest PID stays and the rest go — one source path means
# byte-identical code, so the choice among them is arbitrary. Detached procs
# persist after this script + the session exit.
ensure_recall_worker() {
    # "announce" also speaks on stdout, which the harness injects as context;
    # "quiet" only writes the log. Per-prompt passes are quiet, and the steady
    # state logs nothing at all: a line the model already read at session start is
    # noise on every turn after it, and one log entry per prompt buries the
    # entries that record an actual decision.
    local voice="${1:-quiet}"

    if ! mkdir -p "$RECALL_LOGDIR" 2>/dev/null; then
        # Nothing else reports this, and the symptom is otherwise indistinguishable
        # from "recall found nothing."
        [ "$voice" = announce ] && recall_announce "macrodata-recall: cannot create $RECALL_LOGDIR; ambient recall is NOT running"
        return 0
    fi

    # Matching happens in-shell, with no `grep` in the pipeline, because a grep
    # for this pattern carries the pattern in its OWN argv: a second session's
    # grep, alive for ~10ms inside the ~85ms this snapshot takes, lands in the
    # table and reads back as a worker. Filtering after `ps` exits only rules out
    # our own grep, never anyone else's.
    #
    # The sentinel-root pair must also END the command. It is the last argv the
    # spawn passes, and an unanchored match would let root `/x/mem` claim, and
    # then reap, the worker serving `/x/mem-work`.
    local snapshot pid cmd mine="" stale="" foreign="" survived
    # Only this user's processes are candidates: a state root lives in one home
    # directory, so a worker for it always belongs to its owner, and everything
    # else on a shared machine is something this pass could classify but never
    # signal. `-U` selects by real uid on both BSD and GNU ps, where `-u` means a
    # format shorthand to one of them.
    #
    # An unreadable process table is not an empty one. Treating a failed `ps` as
    # "nothing is running" would clear a live claim and spawn a competitor on
    # every prompt, none of them visible to the next pass either.
    if ! snapshot="$(ps -ww -U "$(id -u)" -o pid=,command= 2>/dev/null)" || [ -z "$snapshot" ]; then
        recall_log "worker: ps returned nothing -> skipping this pass"
        return 0
    fi
    while read -r pid cmd; do
        case "$pid" in ''|*[!0-9]*) continue ;; esac
        case "$cmd" in *"$RECALL_SENTINEL $STATE_ROOT") ;; *) continue ;; esac
        case "$cmd" in
            *"$RECALL_WORKER"*) mine="$mine $pid" ;;
            */plugins/cache/*src/recall/worker.ts*) stale="$stale $pid" ;;
            # Positive evidence only. A catch-all here would classify any process
            # that merely mentions the sentinel — a wrapper shell, an editor, a
            # `ps` pipeline of our own — as a hand-started worker, and the branch
            # below then declines to start the real one.
            *worker.ts*) foreign="$foreign $pid" ;;
        esac
    done <<< "$snapshot"

    # The worker claims worker.pid so a burst of spawns settles on one survivor,
    # and SIGKILL — how a stale version is reaped — leaves that claim behind. A
    # PID outliving its file is harmless (the next worker takes a dead claim
    # over), but a REBOOT restarts the PID space from the bottom, and a claim
    # naming some unrelated system process reads as live forever: every worker
    # stands down and recall is dead with nothing to see.
    #
    # The holder is re-read here rather than looked up in the snapshot above.
    # Asking about one PID now has no staleness window worth the name, while
    # snapshot membership answers a question about the past — and every way a
    # live worker can be absent from that snapshot ends with this block deleting
    # a healthy mutex and the spawn below racing a competitor into the hole.
    local held holder
    if [ -f "$RECALL_PIDFILE" ] && held="$(tr -d '[:space:]' < "$RECALL_PIDFILE" 2>/dev/null)" && [ -n "$held" ]; then
        case "$held" in
            *[!0-9]*)
                recall_log "worker: claim file holds a non-pid -> clear"
                rm -f "$RECALL_PIDFILE" ;;
            *)
                holder="$(ps -ww -p "$held" -o command= 2>/dev/null || true)"
                case "$holder" in
                    *"$RECALL_SENTINEL"*) ;;
                    *) recall_log "worker: claim held by pid $held, not a worker -> clear"
                       rm -f "$RECALL_PIDFILE" ;;
                esac ;;
        esac
    fi

    # A worker from another plugin version runs code no live session asked for, so
    # it goes regardless of what else is up.
    if [ -n "$stale" ]; then
        recall_log "worker: stale plugin-cache worker(s)$stale -> reap"
        survived="$(reap "$stale")"
        [ -n "$survived" ] && recall_log "worker: reap FAILED, survived SIGKILL:$survived"
    fi

    if [ -n "$foreign" ]; then
        # Announced rather than passed over in silence: that worker, not the
        # installed release, is answering recall, and from the outside a worker
        # serving code the release does not contain looks exactly like a healthy
        # one. Both the log line and the echo are session-start only — a working
        # dev checkout is a steady state, and a line per prompt would bury the
        # entries that record an actual decision under the one case guaranteed to
        # repeat on every message for days.
        if [ "$voice" = announce ]; then
            recall_log "worker: hand-started worker(s)$foreign up -> left alone; $RECALL_WORKER is not serving recall"
            recall_announce "macrodata-recall: recall is served by a hand-started worker (pid${foreign}), not the installed plugin"
        fi
        return 0
    fi

    if [ -n "$mine" ]; then
        local ordered keep extras
        # shellcheck disable=SC2086
        ordered="$(printf '%s\n' $mine | sort -n)"
        keep="$(printf '%s\n' "$ordered" | head -1)"
        extras="$(printf '%s\n' "$ordered" | tail -n +2 | tr '\n' ' ')"
        if [ -n "${extras// /}" ]; then
            recall_log "worker: duplicates -> keep $keep, reap $extras"
            survived="$(reap "$extras")"
            [ -n "$survived" ] && recall_log "worker: reap FAILED, survived SIGKILL:$survived"
        elif [ "$voice" = announce ]; then
            recall_log "worker: up (pid $keep)"
        fi
        return 0
    fi

    # A missing source is otherwise a silent per-prompt loop: bun exits with a
    # stack trace into worker.log while this function logs a start that never
    # happened. Reachable mid-upgrade, when the previous version's cache dir is
    # removed under a session still running its code.
    if [ ! -f "$RECALL_WORKER" ]; then
        recall_log "worker: source missing at $RECALL_WORKER -> not starting"
        [ "$voice" = announce ] && recall_announce "macrodata-recall: worker source is missing; ambient recall is NOT running"
        return 0
    fi

    # stdin is closed explicitly: nohup redirects stdout and stderr but leaves
    # stdin alone, so the worker would hold the harness's session pipe open for
    # its whole life — and prompt-submit reads that same pipe after this returns.
    recall_log "worker: down -> starting"
    ( cd "$PLUGIN_ROOT" && nohup bun run "$RECALL_WORKER" "$RECALL_SENTINEL" "$STATE_ROOT" </dev/null >> "$RECALL_LOGDIR/worker.log" 2>&1 & )
}

inject_pending_context() {
    if [ -s "$PENDING_CONTEXT" ]; then
        cat "$PENDING_CONTEXT"
        : > "$PENDING_CONTEXT"  # Clear the file
    fi
}

# Drain fired scheduled tasks. The daemon writes one file per firing into
# .pending-reminders/. We claim each by renaming it before reading: rename(2)
# can move a given source only once, so when several sessions drain at the
# same moment exactly one wins each file and the losers' mv fails silently —
# no scheduled run gets grabbed twice. The claimed name carries the session
# id so the daemon log / a curious human can see who took it.
inject_reminders() {
    [ -d "$PENDING_REMINDERS_DIR" ] || return
    # session_id is external input (harness stdin JSON) and lands in a filename
    # below, so strip it to a safe charset before use.
    local session_id
    session_id=$(printf '%s' "${1:-}" | tr -cd 'A-Za-z0-9_-')
    [ -n "$session_id" ] || session_id="unknown"
    local f base claimed
    for f in "$PENDING_REMINDERS_DIR"/*; do
        [ -e "$f" ] || continue            # no matches: glob stays literal
        base=$(basename "$f")
        case "$base" in
            .*|*.claimed.*) continue ;;    # tmp writes and already-claimed leftovers
        esac
        claimed="$f.claimed.$session_id.$$"
        if mv "$f" "$claimed" 2>/dev/null; then
            cat "$claimed"
            rm -f "$claimed"
        fi
    done
}

inject_first_run() {
    # Once identity.md exists, normal state is delivered by the per-file
    # compose-state-file.ts hooks — nothing to emit here.
    [ -f "$IDENTITY" ] && return

    # Detect user info up front to avoid repeated permission prompts during onboarding.
    local USER_INFO
    USER_INFO=$("$SCRIPT_DIR/detect-user.sh" 2>/dev/null || echo '{}')

    # Neutralize macrodata tag-openers in the detected-user JSON: a hostile
    # git/GECOS name (e.g. user.name containing "</macrodata-detected-user>")
    # would otherwise close the wrapper early or forge a sibling block. The
    # deeper fix (proper JSON escaping at the detect-user.sh source) is tracked
    # as a follow-up.
    USER_INFO="${USER_INFO//<\/macrodata/&lt;/macrodata}"
    USER_INFO="${USER_INFO//<macrodata/&lt;macrodata}"

    echo "<macrodata>
<macrodata-first-run state-root=\"$STATE_ROOT\">
Macrodata local memory is not yet configured. Run \`/onboarding\` to set up.
</macrodata-first-run>

<macrodata-detected-user>
$USER_INFO
</macrodata-detected-user>
</macrodata>"
}

case "$1" in
    session-start)
        start_daemon
        signal_daemon_reload
        inject_first_run
        ensure_recall_worker announce
        ;;
    prompt-submit)
        start_daemon
        ensure_recall_worker quiet
        # session_id rides in on the hook's stdin JSON (absent when run by
        # hand). Read stdin once — it can only be consumed once.
        SESSION_ID=""
        if [ ! -t 0 ]; then
            SESSION_ID=$(jq -r '.session_id // empty' 2>/dev/null)
        fi
        inject_pending_context
        inject_reminders "$SESSION_ID"
        ;;
    recall-worker)
        # Standalone lever: converge the worker without touching the daemon.
        ensure_recall_worker announce
        ;;
    print-root)
        # The bash ladder's answer, exposed so bin/recall-print-root.ts can be
        # held against it (test/state-root-parity.test.ts) rather than trusting
        # two copies of the same precedence to stay in step.
        printf '%s\n' "$STATE_ROOT"
        ;;
    *)
        echo "Usage: $0 {session-start|prompt-submit|recall-worker|print-root}" >&2
        exit 1
        ;;
esac
