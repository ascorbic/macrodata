#!/bin/bash
#
# Macrodata Local Hook Script
#
# Usage:
#   macrodata-hook.sh session-start    - Launch daemon if not running, inject context
#   macrodata-hook.sh prompt-submit    - Check daemon, inject pending context
#   macrodata-hook.sh post-bash        - Log git commands to journal
#   macrodata-hook.sh post-file-change - Log significant file changes
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

# Output locations
PIDFILE="$STATE_ROOT/.daemon.pid"
PENDING_CONTEXT="$STATE_ROOT/.pending-context"
LOGFILE="$STATE_ROOT/.daemon.log"
JOURNAL_DIR="$STATE_ROOT/journal"

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
        # Use Claude Code's bundled Bun if available, otherwise fall back to global
        local BUN="${CLAUDE_CODE_BUN_PATH:-bun}"
        # Ensure state directory exists
        mkdir -p "$STATE_ROOT"
        # Start daemon in background, redirect output to log
        MACRODATA_ROOT="$STATE_ROOT" nohup "$BUN" run "$DAEMON" >> "$LOGFILE" 2>&1 &
        echo $! > "$PIDFILE"
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

get_schedules() {
    local schedules_file="$STATE_ROOT/.schedules.json"
    
    if [ ! -f "$schedules_file" ]; then
        echo "_No active schedules_"
        return
    fi
    
    local schedules=$(jq -r '.schedules[] | "- \(.description) (\(.type): \(.expression))"' "$schedules_file" 2>/dev/null)
    
    if [ -z "$schedules" ]; then
        echo "_No active schedules_"
    else
        echo "$schedules"
    fi
}

inject_static_context() {
    # For local plugin, we inject everything needed for a normal session
    local IDENTITY="$STATE_ROOT/identity.md"
    local TODAY="$STATE_ROOT/state/today.md"
    local HUMAN="$STATE_ROOT/state/human.md"
    local WORKSPACE="$STATE_ROOT/state/workspace.md"
    local CONTEXT_FILE="$STATE_ROOT/.claude-context.md"

    # Build context content
    local CONTEXT=""

    # Check if this is first run (no identity file)
    if [ ! -f "$IDENTITY" ]; then
        CONTEXT="<macrodata-local>
## First Run

Macrodata local memory is not yet configured. Run \`/onboarding\` to set up.

State directory: $STATE_ROOT
</macrodata-local>"
    else
        CONTEXT="<macrodata-local>
## Identity

$(cat "$IDENTITY" 2>/dev/null || echo "_No identity configured_")

## Today

$(cat "$TODAY" 2>/dev/null || echo "_Empty_")

## Human

$(cat "$HUMAN" 2>/dev/null || echo "_Empty_")

## Workspace

$(cat "$WORKSPACE" 2>/dev/null || echo "_Empty_")

## Recent Journal
$(get_recent_journal 5)

## Schedules
$(get_schedules)

## Paths

- Root: \`$STATE_ROOT\`
- State: \`$STATE_ROOT/state\`
- Entities: \`$STATE_ROOT/entities\`
- Journal: \`$STATE_ROOT/journal\`
</macrodata-local>"
    fi

    # Write to file for global CLAUDE.md reference
    mkdir -p "$STATE_ROOT"
    echo "$CONTEXT" > "$CONTEXT_FILE"

    # Also output to stdout for session context
    echo "$CONTEXT"
}

log_to_journal() {
    local topic="$1"
    local content="$2"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    local today=$(date +"%Y-%m-%d")
    local journal_file="$JOURNAL_DIR/$today.jsonl"
    
    mkdir -p "$JOURNAL_DIR"
    
    # Escape content for JSON
    local escaped_content=$(echo "$content" | jq -Rs '.')
    
    echo "{\"timestamp\":\"$timestamp\",\"topic\":\"$topic\",\"content\":$escaped_content,\"metadata\":{\"source\":\"hook\"}}" >> "$journal_file"
}

handle_post_bash() {
    # Read JSON input from stdin
    local input=$(cat)
    
    # Extract command from tool_input
    local command=$(echo "$input" | jq -r '.tool_input.command // empty')
    
    if [ -z "$command" ]; then
        exit 0
    fi
    
    # Only log git commands
    if echo "$command" | grep -qE '^git (commit|push|pull|merge|rebase|checkout -b|branch -[dD])'; then
        local tool_response=$(echo "$input" | jq -r '.tool_response // empty' | head -c 500)
        log_to_journal "git" "Command: $command"
    fi
    
    exit 0
}

handle_post_file_change() {
    # Read JSON input from stdin  
    local input=$(cat)
    
    # Extract file path
    local file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
    local tool_name=$(echo "$input" | jq -r '.tool_name // empty')
    
    if [ -z "$file_path" ]; then
        exit 0
    fi
    
    # Only log significant files (not temp, not hidden, not node_modules)
    if echo "$file_path" | grep -qE '(node_modules|\.tmp|\.cache|__pycache__|\.git/)'; then
        exit 0
    fi
    
    # Log the file change
    log_to_journal "file-change" "$tool_name: $file_path"
    
    exit 0
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
    post-bash)
        handle_post_bash
        ;;
    post-file-change)
        handle_post_file_change
        ;;
    *)
        echo "Usage: $0 {session-start|prompt-submit|post-bash|post-file-change}" >&2
        exit 1
        ;;
esac
