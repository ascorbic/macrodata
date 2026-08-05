#!/bin/sh
#
# Macrodata Dependency Bootstrap
#
# Usage: ensure-deps.sh   (SessionStart hook; no arguments)
#
# Marketplace installs copy the plugin into a per-version cache dir but never
# install its npm dependencies, and Claude Code's dependency auto-install does
# not fire for bun.lock (<https://github.com/anthropics/claude-code/issues/47634>).
# Without a real node_modules the MCP server, daemon and bin/*.ts scripts fall
# back to bun's global auto-install cache, where native modules cannot load:
# the sharp binary resolves @rpath/libvips-cpp.<ver>.dylib relative to a sibling
# node_modules layout the versioned cache dir names do not provide, and phantom
# deps (@huggingface/transformers bare-imports onnxruntime-common) go missing.
#
# So: install into the persistent per-plugin data dir, which survives plugin
# updates and is removed on uninstall, and symlink it into the plugin root so
# every entry point resolves deps normally
# <https://code.claude.com/docs/en/plugins-reference#persistent-data-directory>.
# Delete this script once claude-code#47634 auto-installs from bun.lock.
#
# SessionStart hook stdout is injected into the model's context, so the happy
# path prints NOTHING; diagnostics and subprocess output go to stderr.

set -u

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DATA_DIR="${CLAUDE_PLUGIN_DATA:-}"

# opencode and older Claude Code clients do not set CLAUDE_PLUGIN_DATA. With no
# persistent dir there is nowhere to install; degrade to the status quo.
[ -n "$DATA_DIR" ] || exit 0

# Documented as created on first reference, but do not depend on that.
if ! mkdir -p "$DATA_DIR" 2>/dev/null; then
    echo "macrodata: cannot create plugin data dir $DATA_DIR" >&2
    exit 1
fi

MANIFESTS="package.json bun.lock"
STATUS=0

# Freshness is judged against .installed-* stamp copies, written only AFTER a
# successful install — never against the working manifests bun installs from.
# Copy-then-install (the docs example) leaves matching manifests beside a
# broken tree when the install is killed mid-run (crash, lid close) rather
# than failing, and every later session would no-op on the wreckage.
manifests_changed() {
    for f in $MANIFESTS; do
        cmp -s "$PLUGIN_ROOT/$f" "$DATA_DIR/.installed-$f" || return 0
    done
    return 1
}

remove_stamps() {
    for f in $MANIFESTS; do
        rm -f "$DATA_DIR/.installed-$f"
    done
}

install_deps() {
    # bun reads the manifests from its cwd, so working copies must exist before
    # the install; the stamps above are what record that it finished.
    for f in $MANIFESTS; do
        cp "$PLUGIN_ROOT/$f" "$DATA_DIR/$f" || return 1
    done
    # stdout redirected to stderr: bun's progress output must never reach the
    # hook's stdout. --production: only runtime deps belong in the data dir;
    # dev tooling (linters, test libs) stays a repo-checkout concern.
    (cd "$DATA_DIR" && bun install --frozen-lockfile --production >&2) || return 1
    for f in $MANIFESTS; do
        cp "$PLUGIN_ROOT/$f" "$DATA_DIR/.installed-$f" || return 1
    done
}

# Guard 1: install only when the shipped manifests differ from the stored ones.
if [ -f "$PLUGIN_ROOT/package.json" ] && [ -f "$PLUGIN_ROOT/bun.lock" ] && manifests_changed; then
    if ! install_deps; then
        # Drop the stamps so the next session retries instead of treating a
        # failed install as up to date.
        remove_stamps
        echo "macrodata: dependency install failed; MCP tools may not work (see output above)" >&2
        STATUS=1
    fi
fi

# Guard 2: link the installed tree into the plugin root. Runs even when Guard 1
# was a no-op — a plugin update lands a fresh version dir whose manifests match
# but which has no symlink yet.
LINK="$PLUGIN_ROOT/node_modules"
TARGET="$DATA_DIR/node_modules"
if [ -L "$LINK" ]; then
    if [ "$(readlink "$LINK")" != "$TARGET" ]; then
        ln -sfn "$TARGET" "$LINK" || STATUS=1
    fi
elif [ -e "$LINK" ]; then
    # A real directory: a dev checkout's own install, or the repo itself run via
    # --plugin-dir. Never replace it.
    :
else
    ln -sfn "$TARGET" "$LINK" || STATUS=1
fi

exit "$STATUS"
