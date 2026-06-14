#!/bin/bash
#
# Macrodata Local Hook Script
#
# Usage:
#   macrodata-hook.sh session-start    - Launch daemon if not running, inject context
#   macrodata-hook.sh prompt-submit    - Check daemon, inject pending context
#

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$SCRIPT_DIR/macrodata-daemon.ts"

# State directory (configurable via MACRODATA_ROOT, config file, or defaults to ~/.config/macrodata)
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

# Output locations (PID file now follows STATE_ROOT for testing isolation)
PIDFILE="$STATE_ROOT/.daemon.pid"
PENDING_CONTEXT="$STATE_ROOT/.pending-context"
LOGFILE="$STATE_ROOT/.daemon.log"
JOURNAL_DIR="$STATE_ROOT/journal"

# State files
IDENTITY="$STATE_ROOT/state/identity.md"
TODAY="$STATE_ROOT/state/today.md"
HUMAN="$STATE_ROOT/state/human.md"
WORKSPACE="$STATE_ROOT/state/workspace.md"
FLAGS="$STATE_ROOT/state/flags.md"

# Per-section injection caps (bytes) — a backstop against runaway growth, not a
# tight corset. State is bounded working memory; a file over cap is truncated here
# with a marker. The skills keep files well under this; the cap only catches failures.
CAP_IDENTITY=4000
CAP_TODAY=4000
CAP_HUMAN=4000
CAP_WORKSPACE=4000
CAP_FLAGS=4000

is_daemon_running() {
    if [ -f "$PIDFILE" ]; then
        local pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

start_daemon() {
    if is_daemon_running; then
        return 0
    fi

    local BUN="bun"
    # Ensure state directory exists
    mkdir -p "$STATE_ROOT"
    # Start daemon in background, redirect output to log
    # Note: daemon writes its own PID file, we don't write it here
    MACRODATA_ROOT="$STATE_ROOT" nohup "$BUN" run "$DAEMON" >> "$LOGFILE" 2>&1 &

    # Wait briefly for daemon to write PID file (up to 2 seconds)
    local attempts=0
    while [ $attempts -lt 20 ]; do
        sleep 0.1
        if is_daemon_running; then
            return 0
        fi
        attempts=$((attempts + 1))
    done
}

signal_daemon_reload() {
    if [ -f "$PIDFILE" ]; then
        local pid=$(cat "$PIDFILE")
        if kill -0 "$pid" 2>/dev/null; then
            kill -HUP "$pid" 2>/dev/null
        fi
    fi
}

inject_pending_context() {
    if [ -s "$PENDING_CONTEXT" ]; then
        cat "$PENDING_CONTEXT"
        : > "$PENDING_CONTEXT"  # Clear the file
    fi
}

get_recent_journal() {
    local count="${1:-5}"
    
    if [ ! -d "$JOURNAL_DIR" ]; then
        return
    fi
    
    # Get most recent journal files and extract entries
    local entries=""
    for file in $(ls -t "$JOURNAL_DIR"/*.jsonl 2>/dev/null | head -3); do
        if [ -f "$file" ]; then
            # Get last N entries from each file, format as "- [topic] content"
            entries="$entries$(tail -n "$count" "$file" 2>/dev/null | jq -r '"\n- [\(.topic)] \(.content | split("\n")[0])"' 2>/dev/null)"
        fi
    done
    
    echo "$entries" | head -n "$count"
}

list_state_files() {
    local files=""

    # State files
    if [ -d "$STATE_ROOT/state" ]; then
        for f in "$STATE_ROOT/state"/*.md; do
            [ -f "$f" ] && files="$files\n- state/$(basename "$f")"
        done
    fi

    # Entity files (scan all subdirs dynamically)
    if [ -d "$STATE_ROOT/entities" ]; then
        for subdir in "$STATE_ROOT/entities"/*/; do
            [ -d "$subdir" ] || continue
            local subdir_name=$(basename "$subdir")
            for f in "$subdir"*.md; do
                [ -f "$f" ] && files="$files\n- entities/$subdir_name/$(basename "$f")"
            done
        done
    fi

    if [ -z "$files" ]; then
        echo "_No files yet_"
    else
        echo -e "$files"
    fi
}

get_usage() {
    cat <<'USAGE'
- **state/** files are always here but BOUNDED (a screenful each, hard-capped). Keep only what's live; move detail out.
- **flags.md** is how things reach the user across sessions — one line + pointer. Surface, don't hoard.
- **journal** (`log_journal`) is durable and retrievable via `search_memory`. Writing it down is remembering, not forgetting — put detail here.
- **entities/** hold persistent per-project/topic notes (searchable). Eviction is expected: resolved/aging items leave state for the journal/entity, leaving a pointer.
- Search before claiming ignorance. Full guide: `plugins/macrodata/USAGE.md`.
USAGE
}

get_schedules() {
    local reminders_dir="$STATE_ROOT/reminders"

    if [ ! -d "$reminders_dir" ]; then
        echo "_No active schedules_"
        return
    fi

    local schedules=""
    for f in "$reminders_dir"/*.json; do
        [ -f "$f" ] || continue
        local line=$(jq -r '"- \(.description) (\(.type): \(.expression))"' "$f" 2>/dev/null)
        [ -n "$line" ] && schedules="$schedules$line\n"
    done

    if [ -z "$schedules" ]; then
        echo "_No active schedules_"
    else
        echo -e "$schedules"
    fi
}

cap_file() {
    local file="$1" max="$2"
    if [ ! -f "$file" ]; then echo "_Empty_"; return; fi
    local size
    size=$(wc -c < "$file" | tr -d ' ')
    if [ "$size" -le "$max" ]; then
        cat "$file"
    else
        head -c "$max" "$file" | sed -e '$ d'
        printf '\n[…truncated: %s of %s bytes shown. This file is over its budget — compact it. Detail lives in the journal; use search_memory / get_recent_journal.]\n' "$max" "$size"
    fi
}

inject_static_context() {
    # For local plugin, we inject everything needed for a normal session
    local CONTEXT_FILE="$STATE_ROOT/.claude-context.md"

    # Build context content
    local CONTEXT=""

    # Check if this is first run (no identity file)
    if [ ! -f "$IDENTITY" ]; then
        # Detect user info to avoid multiple permission prompts during onboarding
        local USER_INFO=$("$SCRIPT_DIR/detect-user.sh" 2>/dev/null || echo '{}')
        
        CONTEXT="<macrodata>
<macrodata-first-run state-root=\"$STATE_ROOT\">
Macrodata local memory is not yet configured. Run \`/onboarding\` to set up.
</macrodata-first-run>

<macrodata-detected-user>
$USER_INFO
</macrodata-detected-user>
</macrodata>"
    else
        CONTEXT="<macrodata>
<macrodata-flags>
$([ -s "$FLAGS" ] && cap_file "$FLAGS" "$CAP_FLAGS" || echo "_No open flags_")
</macrodata-flags>

<macrodata-today>
$(cap_file "$TODAY" "$CAP_TODAY")
</macrodata-today>

<macrodata-identity>
$(cap_file "$IDENTITY" "$CAP_IDENTITY")
</macrodata-identity>

<macrodata-workspace>
$(cap_file "$WORKSPACE" "$CAP_WORKSPACE")
</macrodata-workspace>

<macrodata-journal>
$(get_recent_journal 3)
</macrodata-journal>

<macrodata-schedules>
$(get_schedules)
</macrodata-schedules>

<macrodata-usage>
$(get_usage)
</macrodata-usage>

<macrodata-files root=\"$STATE_ROOT\">
$(list_state_files)
</macrodata-files>
</macrodata>"
    fi

    # Write to file for global CLAUDE.md reference
    mkdir -p "$STATE_ROOT"
    echo "$CONTEXT" > "$CONTEXT_FILE"

    # Also output to stdout for session context
    echo "$CONTEXT"
}

case "$1" in
    session-start)
        start_daemon
        signal_daemon_reload
        inject_static_context
        ;;
    prompt-submit)
        # Restart daemon if dead
        start_daemon
        # Inject only the daemon's targeted deltas. The full context is injected
        # once at session-start and stays in the cached prefix; re-dumping it here
        # would bloat the running context every turn and defeat prompt caching.
        inject_pending_context
        ;;
    *)
        echo "Usage: $0 {session-start|prompt-submit}" >&2
        exit 1
        ;;
esac
