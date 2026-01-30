#!/bin/bash
#
# Macrodata Hook Script
#
# Usage:
#   macrodata-hook.sh session-start  - Launch daemon if not running, inject context
#   macrodata-hook.sh prompt-submit  - Check daemon, inject pending context
#

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$SCRIPT_DIR/macrodata-daemon.ts"

# Output locations (always in ~/.claude)
PIDFILE="$HOME/.claude/macrodata-daemon.pid"
PENDING_CONTEXT="$HOME/.claude/pending-context"
STATIC_CONTEXT="$HOME/.claude/macrodata-context.md"
LOGFILE="$HOME/.claude/macrodata-daemon.log"

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
    if ! is_daemon_running; then
        # Start daemon in background, redirect output to log
        nohup bun run "$DAEMON" >> "$LOGFILE" 2>&1 &
        echo $! > "$PIDFILE"
    fi
}

inject_pending_context() {
    if [ -s "$PENDING_CONTEXT" ]; then
        cat "$PENDING_CONTEXT"
        : > "$PENDING_CONTEXT"  # Clear the file
    fi
}

inject_static_context() {
    if [ -f "$STATIC_CONTEXT" ]; then
        echo "<macrodata-context>"
        cat "$STATIC_CONTEXT"
        echo "</macrodata-context>"
    fi
}

case "$1" in
    session-start)
        start_daemon
        inject_static_context
        ;;
    prompt-submit)
        # Restart daemon if dead
        start_daemon
        # Inject any pending context
        inject_pending_context
        ;;
    *)
        echo "Usage: $0 {session-start|prompt-submit}" >&2
        exit 1
        ;;
esac
