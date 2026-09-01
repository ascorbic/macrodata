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

# One directory, one spelling of it.
#
# The root string is this hook's IDENTITY for a worker: it is passed in the
# worker's argv, and every later pass decides "is that worker mine?" by comparing
# that argv tail against this variable. Storage, meanwhile, resolves through the
# kernel, which folds `/a/root/` into `/a/root` and (on macOS) `/tmp` into
# `/private/tmp`. Two spellings of one directory are therefore one mailbox and
# one pidfile but two identities: each session reads the other's claim as a
# foreign root's, deletes a live pidfile, and starts a second ~1.2GB worker on
# the same store. Canonicalizing at the resolver is what keeps the two meanings
# of "the same root" from drifting apart. Mirrored by getStateRoot() in
# src/config.ts, which every other entry point resolves through.
#
# Nonzero, printing nothing, for a root no worker could be managed under.
canonicalize_root() {
    local p="$1"
    # A control character makes the root unusable, not merely unusual: `ps`
    # renders a newline as `\012` and `read -r` splits the table on it, so the
    # argv comparison can never match again. The worker is then invisible to the
    # pass that spawned it, and a new one starts per prompt, without bound.
    case "$p" in
        ''|*[[:cntrl:]]*) return 1 ;;
    esac
    while :; do
        case "$p" in
            /) break ;;
            */) p="${p%/}" ;;
            *) break ;;
        esac
    done
    [ -n "$p" ] || return 1
    # -P resolves symlinks, so /tmp and /private/tmp arrive as one string. A root
    # that does not exist yet has nothing to resolve and keeps its written form;
    # the pass that creates it canonicalizes from then on.
    if [ -d "$p" ]; then
        p="$(cd -P "$p" 2>/dev/null && pwd -P)" || return 1
        [ -n "$p" ] || return 1
    fi
    printf '%s' "$p"
}

STATE_ROOT=""
if [ -n "$MACRODATA_ROOT" ]; then
    STATE_ROOT="$(canonicalize_root "$MACRODATA_ROOT")" || STATE_ROOT=""
elif [ -f "$CONFIG_FILE" ]; then
    # Type-checked, not just present: `-r` renders a number, a bool, or a whole
    # object as text, and a root of `123` would resolve here while the TypeScript
    # resolver hands the same value to path.join() and throws. The two must agree
    # on every config a person can write, so both require a string — and then
    # both require that string to be a usable path.
    # jq drops a control-charactered root rather than handing it to command
    # substitution, which silently deletes NUL bytes and (bash >= 4.4) warns on
    # stderr while doing it — a squeak on every prompt, and a root the shell and
    # getStateRoot() would then disagree about, since only one of them saw the NUL.
    CONFIGURED_ROOT=$(jq -r 'if (.root | type) == "string" and ((.root | explode | map(. < 32 or . == 127) | any) | not) then .root else empty end' "$CONFIG_FILE" 2>/dev/null)
    [ -n "$CONFIGURED_ROOT" ] && { STATE_ROOT="$(canonicalize_root "$CONFIGURED_ROOT")" || STATE_ROOT=""; }
fi
[ -n "$STATE_ROOT" ] || STATE_ROOT="$(canonicalize_root "$DEFAULT_ROOT")" || STATE_ROOT="$DEFAULT_ROOT"
[ -n "$STATE_ROOT" ] || STATE_ROOT="$DEFAULT_ROOT"

PIDFILE="$STATE_ROOT/.daemon.pid"
PENDING_CONTEXT="$STATE_ROOT/.pending-context"
LOGFILE="$STATE_ROOT/.daemon.log"
IDENTITY="$STATE_ROOT/state/identity.md"
FLAGS="$STATE_ROOT/state/flags.md"
REMINDERS="$STATE_ROOT/state/reminders.md"
# Recall logs live under the state root beside the rest of the runtime state, NOT
# beside the source: the plugin installs into a per-version cache dir, so a
# source-relative log would be orphaned by every release.
RECALL_LOGDIR="$STATE_ROOT/.recall"
# Written by the worker itself (getWorkerPidPath in src/recall/config.ts), which
# claims it exclusively so a burst of spawns settles on one survivor. Liveness is
# still decided by `ps` here, never by this file.
RECALL_PIDFILE="$RECALL_LOGDIR/worker.pid"
# Consecutive spawns that left no worker, and when the last one was. A worker
# that dies during startup leaves the next pass looking exactly like a first
# start, so a count is the only evidence that one ever failed.
#
# Counted rather than timed. Reaching the spawn below means no worker was found,
# so an entry that survives to be incremented is a spawn that produced nothing —
# regardless of whether the passes were seconds or hours apart. A window between
# attempts would instead measure how fast the human types: at any real prompt
# cadence every gap exceeds it, and the detector never fires for the one person
# it exists for.
RECALL_SPAWN_STAMP="$RECALL_LOGDIR/last-spawn"
# Two in a row, because a single failure is also what a reap-then-respawn and a
# lost spawn race look like, and both of those are healthy by the next pass.
RECALL_SPAWN_FAIL_COUNT=2

# Is this command line a recall worker serving THIS state root?
#
# The sentinel-root pair must END the command: it is the last argv the spawn
# passes, and an unanchored match would let root `/x/mem` claim, and then reap,
# the worker serving `/x/mem-work`.
#
# One predicate rather than the pattern written at each call site. Two call sites
# ask this question — the `ps` classifier and the pidfile-claim guard — and they
# ask it about the same thing for opposite purposes, so a guard that accepts more
# than the classifier counts hands this root's claim to another root's worker:
# the claim then survives every pass, no worker for this root can ever take it,
# and recall is dead in a state that cannot self-heal.
is_recall_worker_argv() {
    case "$1" in
        *"$RECALL_SENTINEL $STATE_ROOT") return 0 ;;
        *) return 1 ;;
    esac
}

# Close every fd above stderr before exec'ing a long-lived background process.
# bun's spawnSync (which invokes this hook) may open internal pipe fds at
# unpredictable numbers; a child that inherits any of them prevents the caller
# from ever seeing EOF on stdout. Portable: /proc/self/fd on Linux, /dev/fd on
# macOS. Must be called inside a ( subshell ) so the closures don't affect the
# hook script itself.
close_inherited_fds() {
    local fd
    for fd in $(command ls /proc/self/fd 2>/dev/null || command ls /dev/fd 2>/dev/null); do
        [ "$fd" -gt 2 ] && eval "exec $fd>&-" 2>/dev/null || true
    done
}

# What can actually be said about a PID: 0 alive, 1 definitely gone, 2 unknown.
#
# `kill -0` fails for two unrelated reasons and the difference decides whether a
# process may be written off: ESRCH means gone, EPERM means alive and owned by
# someone else. Reading the second as the first reports a successful reap of a
# process that is still running, and clears a claim still held. worker.ts's
# alive() draws the same distinction.
pid_state() {
    local err
    err="$(kill -0 "$1" 2>&1)" && return 0
    case "$err" in
        *[Nn]"o such process"*) return 1 ;;
        *) return 2 ;;
    esac
}

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
    # Only a positive "gone" counts as reaped. Anything else — still alive, or a
    # state this shell cannot determine — is reported as a survivor, because the
    # caller's next move is to log a failed reap and leave the process alone.
    pid_state "$pid"
    [ "$?" -eq 1 ]
}

# Delete the worker claim, but only while it still names the PID the decision was
# made about. The `ps` that produced that decision forks, and a worker claiming
# the file inside that window — the post-reap race this whole path exists for —
# would otherwise lose a live mutex to a verdict about the PID it replaced. The
# re-read narrows the window to the two adjacent syscalls below; it does not
# close it, and nothing available to a shell script does. worker.ts's own unlink
# is content-checked for the same reason and with the same caveat.
claim_clear() {
    [ "$(tr -d '[:space:]' < "$RECALL_PIDFILE" 2>/dev/null)" = "$1" ] && rm -f "$RECALL_PIDFILE"
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
        # Re-read the argv immediately before the kill rather than trusting the
        # `ps` snapshot this list was built from. Reaping is slow — up to 4s per
        # pid across the two escalations — so by the time a later pid comes up,
        # its snapshot entry may describe a process that has already exited and
        # had its number reissued, and the kill would land on whatever holds the
        # number now. A worker that left on its own is simply gone, not a
        # survivor.
        is_recall_worker_argv "$(ps -ww -p "$pid" -o command= 2>/dev/null || true)" || continue
        kill_verified "$pid" || survivors="$survivors $pid"
    done
    printf '%s' "$survivors"
}

# Neutralize macrodata tag-openers in text about to be injected into the model's
# context.
#
# Everything this script injects is wrapped in a <macrodata-*> block, and content
# carrying a closing tag ends its wrapper early: the rest then lands as a sibling
# of the harness's own blocks, indistinguishable from something the harness said.
# The content is attacker-reachable at every call site — a git or GECOS name, a
# state root set by a checked-in .envrc, a memory file.
#
# Filtered with sed rather than ${var//}: from bash 5.2 an unescaped `&` in a
# replacement expands to the text that matched, so `&lt;` reproduces the very tag
# it was meant to defuse, while the `\&` that fixes that is a literal backslash
# in the bash 3.2 macOS ships as /bin/bash. No one replacement word is correct on
# both, and this script runs on both.
neutralize_tags() {
    sed 's/<\/macrodata/\&lt;\/macrodata/g; s/<macrodata/\&lt;macrodata/g'
}

# An announcement is injected into the model's context, so it arrives tagged like
# every other injected block. Bare prose there is indistinguishable from something
# the user wrote, which is the one reading that makes a worker warning actionable
# by the wrong party.
recall_announce() {
    # Neutralized like every other injected block: these messages interpolate the
    # state root, which is attacker-reachable wherever config.json or the
    # environment is.
    printf '<macrodata-recall-status>\n%s\n</macrodata-recall-status>\n' \
        "$(printf '%s' "$1" | neutralize_tags)"
}

# Keep the tail of an append-only recall log, in place.
#
# These files are the forensic record for a liveness incident, and the incident
# that fills them is the one being read back: a per-prompt failure loop writes a
# line or a stack trace per message, so unbounded they bury themselves. Truncated
# rather than rotated to a `.1` sibling — this gets read by hand, mid-incident,
# and a rotation puts half the story in a file nobody thinks to open.
RECALL_LOG_MAX_BYTES=1048576
# Both ends of the trim are measured in bytes. Triggering on a size and cutting
# on a line count are two different measurements, and a log of wide records
# satisfies the second while staying above the first: 2MB across 100 NDJSON lines
# keeps every line, removes nothing, and rewrites a multi-megabyte file on every
# call for as long as the file lives. Bytes on both ends means one trim is enough.
RECALL_LOG_KEEP_BYTES=524288
trim_log() {
    local f="$1" size tmp
    [ -f "$f" ] || return 0
    size="$(wc -c < "$f" 2>/dev/null | tr -d '[:space:]')"
    case "$size" in ''|*[!0-9]*) return 0 ;; esac
    [ "$size" -gt "$RECALL_LOG_MAX_BYTES" ] || return 0
    # PID in the scratch name, like atomicWrite's: every session on the machine
    # runs this against the same log, and a shared scratch path is O_TRUNC — one
    # trimmer would publish another's half-written copy over the log.
    tmp="$f.$$.trim"
    # The work runs in a subshell for two reasons. Its EXIT trap removes the
    # scratch file if the hook is killed mid-trim, where a trap set directly in
    # this function would replace the script's own. And the redirections are
    # inside it: a failing `> "$tmp"` is the SHELL's error, printed before any
    # command's own 2>/dev/null applies, and this function runs on every log
    # line, so on a root that has become unwritable that message would reach the
    # user once per write.
    (
        trap 'rm -f "$tmp"' EXIT HUP INT TERM
        # The first line is a fragment after a byte-bounded cut; dropping it
        # keeps every record in the file whole.
        tail -c "$RECALL_LOG_KEEP_BYTES" "$f" | sed '1d' > "$tmp" || exit 0
        # Copied back rather than renamed into place. The worker holds this file
        # open with `>>` for its whole life, and a rename swaps the inode out
        # from under that fd: the worker keeps writing, to a file now unlinked,
        # and its log goes silent for the rest of the process — during the
        # per-prompt failure loop that is the only realistic way the file got
        # this big. Appends racing the copy are lost instead, which is a few
        # lines rather than all of them.
        cat "$tmp" > "$f"
    ) 2>/dev/null
    rm -f "$tmp"
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
    # Daemon writes its own PID file; we don't write it here. The subshell
    # closes all inherited fds above stderr (see close_inherited_fds) so the
    # daemon can't hold bun's spawnSync pipe open and block the caller.
    ( close_inherited_fds; MACRODATA_ROOT="$STATE_ROOT" exec nohup "$BUN" run "$DAEMON" </dev/null >> "$LOGFILE" 2>&1 ) &

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
recall_log() {
    # The 2> comes first so it is in place before the append is attempted: a
    # redirect that fails is reported by the SHELL, and on a state root that has
    # become unwritable that message would otherwise reach the user's terminal
    # once per log line, on every prompt, describing a condition they cannot act
    # on from there.
    echo "[$(date '+%F %T')] $*" 2>/dev/null >> "$RECALL_LOGDIR/supervisor.log"
    trim_log "$RECALL_LOGDIR/supervisor.log"
}

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

    # Both recall logs are bounded on every pass, not on the spawn path. The
    # worker fills worker.log for as long as it lives, so a trim that only runs
    # where a worker is being started is a trim that a healthy root never
    # reaches — and the run that fills the file fastest, a worker looping on a
    # request it cannot serve, is one where a spawn never happens. trim_log is
    # a no-op below the size trigger and safe against the worker's open append
    # fd, so calling it here costs a stat.
    trim_log "$RECALL_LOGDIR/worker.log"

    # Matching happens in-shell, with no `grep` in the pipeline, because a grep
    # for this pattern carries the pattern in its OWN argv: a second session's
    # grep, alive for ~10ms inside the ~85ms this snapshot takes, lands in the
    # table and reads back as a worker. Filtering after `ps` exits only rules out
    # our own grep, never anyone else's.
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
        is_recall_worker_argv "$cmd" || continue
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
                # Three answers, not two. Only a positive verdict justifies
                # deleting another process's mutex: an unreadable process table,
                # a `ps` that could not fork, or a holder owned by another user
                # all mean this pass does not know, and "does not know" leaves
                # the claim standing for the next one. Reading any of them as
                # "dead" clears a live claim and puts a second worker on the
                # mailbox.
                pid_state "$held"
                case "$?" in
                    1)
                        claim_clear "$held" &&
                            recall_log "worker: claim held by dead pid $held -> cleared" ;;
                    0)
                        if holder="$(ps -ww -p "$held" -o command= 2>/dev/null)" &&
                           [ -n "$holder" ] && ! is_recall_worker_argv "$holder"; then
                            claim_clear "$held" &&
                                recall_log "worker: claim held by pid $held, not a worker for this root -> cleared"
                        fi ;;
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
        # A hand-started worker is never reaped — someone is debugging with it,
        # and this runs on every prompt. The INSTALLED ones still are: every
        # worker on a root drains the same mailbox, so an installed worker
        # alongside a hand-started one makes each request a race between two
        # copies of the code, decided per request and invisible either way. That
        # is also the state the announcement below would otherwise describe
        # wrongly, in the one message whose whole job is to say which code is
        # answering recall.
        if [ -n "$mine" ]; then
            recall_log "worker: hand-started worker(s)$foreign up -> reap installed$mine so one worker drains the mailbox"
            survived="$(reap "$mine")"
            [ -n "$survived" ] && recall_log "worker: reap FAILED, survived SIGKILL:$survived"
        fi
        # Announced rather than passed over in silence: that worker, not the
        # installed release, is answering recall, and from the outside a worker
        # serving code the release does not contain looks exactly like a healthy
        # one. Both the log line and the echo are session-start only — a working
        # dev checkout is a steady state, and a line per prompt would bury the
        # entries that record an actual decision under the one case guaranteed to
        # repeat on every message for days.
        # A hand-started worker is a worker: recall is being served, so no spawn
        # is owed and the failed-spawn count has nothing left to describe.
        # Returning without this reset leaves whatever the count was frozen
        # across the whole debugging session, to be spent on the first pass after
        # the dev worker goes away.
        rm -f "$RECALL_SPAWN_STAMP"
        if [ "$voice" = announce ]; then
            recall_log "worker: hand-started worker(s)$foreign up -> left alone; $RECALL_WORKER is not serving recall"
            recall_announce "macrodata-recall: recall is served by a hand-started worker (pid${foreign}), not the installed plugin"
        fi
        return 0
    fi

    if [ -n "$mine" ]; then
        # A worker is up, so every spawn the counter remembers did its job. This
        # is the only reset: without it the count is cumulative rather than
        # consecutive, and one bad afternoon warns forever.
        rm -f "$RECALL_SPAWN_STAMP"
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

    # A spawn is fire-and-forget — nothing here waits to see whether it lived —
    # so a worker that dies during startup writes the same log line as a healthy
    # first start and gets retried once per prompt forever. `bun` off PATH, a
    # native module broken by an OS update, ENOSPC and OOM all look like this.
    # Two consecutive passes needing a spawn, seconds apart, is the signature:
    # the previous one did not survive its own startup.
    # Guarded rather than left to `2>/dev/null` on the read: a redirect from a
    # missing file is the SHELL's error, reported before the command's own stderr
    # is redirected anywhere. Unguarded, every first-ever spawn on a fresh state
    # root writes a "No such file" line to the hook's stderr.
    local spawns=0 first="" now age
    now="$(date +%s)"
    if [ -f "$RECALL_SPAWN_STAMP" ]; then
        # One line per spawn, counted — not a number read, incremented, and
        # written back. Several sessions reaching this line together is not an
        # edge case, it IS the signature the count exists to report: a root whose
        # worker will not start has every open session spawning on every prompt.
        # A read-modify-write loses exactly that case (both read 1, both store 2,
        # the count reads healthy forever), while a short append under O_APPEND
        # cannot lose a peer's.
        spawns="$(wc -l < "$RECALL_SPAWN_STAMP" 2>/dev/null | tr -d '[:space:]')"
        first="$(head -1 "$RECALL_SPAWN_STAMP" 2>/dev/null)"
    fi
    # Re-validated rather than trusted: this file survives crashes and
    # downgrades, so it can hold anything an older version wrote.
    case "$spawns" in ''|*[!0-9]*) spawns=0 ;; esac
    case "$first" in ''|*[!0-9]*) first="" ;; esac
    # Counted only once the append is on disk, and base 10 explicitly — a stamp
    # left half-written can hold a leading zero, and arithmetic on one is octal,
    # which errors out and freezes the counter at the value it already had.
    if printf '%s\n' "$now" >> "$RECALL_SPAWN_STAMP" 2>/dev/null; then
        spawns=$((10#$spawns + 1))
    fi
    if [ "$spawns" -ge "$RECALL_SPAWN_FAIL_COUNT" ]; then
        age=""
        [ -n "$first" ] && age=" (first $((now - first))s ago)"
        recall_log "worker: $spawns consecutive starts left no worker$age -> startup is failing; see worker.log"
        # Announce-only, like every other steady-state line: a failing spawn
        # repeats per prompt, and a warning on every message is how the next
        # real warning gets ignored. The log carries every occurrence.
        [ "$voice" = announce ] && recall_announce "macrodata-recall: the worker is failing to start; ambient recall is NOT running (see $RECALL_LOGDIR/worker.log)"
    fi

    # The subshell closes all inherited fds above stderr (see close_inherited_fds)
    # before exec'ing the worker, so it can't hold bun's spawnSync pipe open.
    # stdin goes to /dev/null because nohup only redirects stdout and stderr.
    recall_log "worker: down -> starting"
    ( close_inherited_fds; cd "$PLUGIN_ROOT" && exec nohup bun run "$RECALL_WORKER" "$RECALL_SENTINEL" "$STATE_ROOT" </dev/null >> "$RECALL_LOGDIR/worker.log" 2>&1 ) &
}

inject_pending_context() {
    if [ -s "$PENDING_CONTEXT" ]; then
        cat "$PENDING_CONTEXT"
        : > "$PENDING_CONTEXT"  # Clear the file
    fi
}

# Claude Code collects a hook's whole stdout against one 10,000-UTF-16-unit cap
# and, past it, replaces everything with a 2,000-char preview plus a file path —
# so an unbounded relay silently erases itself and every sibling block. Both
# relays below share the prompt-submit budget with pending context, so each
# keeps whole lines up to RELAY_BUDGET_BYTES (a byte count is an upper bound on
# UTF-16 units, so LC_ALL=C byte lengths never under-count) and names what it
# dropped. $1 = byte budget, $2 = the state file to read for the rest; section
# on stdin.
RELAY_BUDGET_BYTES=2500
budget_section() {
    LC_ALL=C awk -v max="$1" -v file="$2" '
        !dropped && total + length($0) + 1 <= max { total += length($0) + 1; print; next }
        { dropped++ }
        END { if (dropped) printf "… %d more line(s) not shown; read %s\n", dropped, file }
    '
}

# Record that a relay was emitted for this session+section, after the emit —
# the file is a dedup log, not a delivery receipt, and keeping it short bounds
# the grep on every prompt. $1 = seen file, $2 = key.
mark_surfaced() {
    echo "$2" >> "$1"
    tail -n 200 "$1" > "$1.tmp" && mv "$1.tmp" "$1"
}

# Session-start preamble is weak: a model with flags in its prefix still answers
# the prompt instead of relaying them. An instruction injected adjacent to the
# user's prompt is followed far more reliably, so remind there — once per
# session per 🔴-section state (a global once-per-change marker gets consumed
# by whichever session fires first, silencing every other session).
# $1 is the session id from the hook's stdin JSON, may be empty.
inject_red_flag_reminder() {
    [ -s "$FLAGS" ] || return 0
    local red_section
    red_section=$(awk '/^## /{inred = /^## 🔴/} inred' "$FLAGS" | neutralize_tags)
    printf '%s' "$red_section" | grep -q '^- ' || return 0
    local hash
    hash=$(printf '%s' "$red_section" | md5 -q 2>/dev/null || printf '%s' "$red_section" | md5sum | cut -d' ' -f1)
    local key="${1:-global}:$hash"
    local seen="$STATE_ROOT/.flags-surfaced"
    grep -qxF "$key" "$seen" 2>/dev/null && return 0
    cat <<EOF
<macrodata-red-flags>
Unresolved 🔴 flags the user has not yet been shown. Relay these at the start of your reply — one line each — before addressing their prompt:
$(printf '%s\n' "$red_section" | budget_section "$RELAY_BUDGET_BYTES" state/flags.md)
</macrodata-red-flags>
EOF
    mark_surfaced "$seen" "$key"
}

# Same prompt-adjacent relay as inject_red_flag_reminder, for fired notify
# reminders. The daemon upserts one line per schedule into state/reminders.md;
# every session sees the file, and a reminder is cleared by the model removing
# its line once it's been relayed and addressed — deduping here is only about
# not repeating the nudge while the entries are unchanged. The entry lines are
# the unit, not the heading: a hand-trimmed file that lost its "## ⏰" line
# still relays. The dedup key hashes every entry, budgeted or not, so a fire
# past the visible cut still re-arms the nudge.
# $1 is the session id from the hook's stdin JSON, may be empty.
inject_reminder_relay() {
    [ -s "$REMINDERS" ] || return 0
    local section
    section=$(grep '^- ' "$REMINDERS" \
        | neutralize_tags)
    [ -n "$section" ] || return 0
    local hash
    hash=$(printf '%s' "$section" | md5 -q 2>/dev/null || printf '%s' "$section" | md5sum | cut -d' ' -f1)
    local key="${1:-global}:$hash"
    local seen="$STATE_ROOT/.reminders-surfaced"
    grep -qxF "$key" "$seen" 2>/dev/null && return 0
    cat <<EOF
<macrodata-reminders>
Fired reminders the user may not have seen. Relay each inline at the start of your reply, with its fired-at time. If one fired hours ago, acknowledge the staleness ("this fired at HH:MM") instead of nudging as if fresh. Once a reminder has been relayed and addressed, remove its line from state/reminders.md with the Edit tool:
$(printf '%s\n' "$section" | budget_section "$RELAY_BUDGET_BYTES" state/reminders.md)
</macrodata-reminders>
EOF
    mark_surfaced "$seen" "$key"
}

inject_first_run() {
    # Once identity.md exists, normal state is delivered by the per-file
    # compose-state-file.ts hooks — nothing to emit here.
    [ -f "$IDENTITY" ] && return

    # Detect user info up front to avoid repeated permission prompts during onboarding.
    local USER_INFO
    USER_INFO=$("$SCRIPT_DIR/detect-user.sh" 2>/dev/null || echo '{}')

    # A hostile git/GECOS name (user.name containing "</macrodata-detected-user>")
    # would otherwise close the wrapper early or forge a sibling block. The deeper
    # fix (proper JSON escaping at the detect-user.sh source) is tracked as a
    # follow-up.
    USER_INFO="$(printf '%s' "$USER_INFO" | neutralize_tags)"

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
        inject_reminder_relay "$SESSION_ID"
        inject_red_flag_reminder "$SESSION_ID"
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
