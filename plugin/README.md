# Macrodata Claude Code Plugin

Real-time cloud memory for Claude Code. Streams context updates via WebSocket and injects state into sessions.

## Prerequisites

- [Bun](https://bun.sh) runtime installed
- Macrodata MCP server configured via `/mcp`

## Installation

### Option 1: Via marketplace (recommended)

```bash
# Add the macrodata marketplace from GitHub
claude plugin marketplace add github:ascorbic/macrodata

# Install the plugin
claude plugin install macrodata@macrodata --scope user
```

### Option 2: Use --plugin-dir flag

```bash
# Load the plugin for a single session
claude --plugin-dir /path/to/macrodata/plugin
```

### Option 3: Add to settings

Add to `~/.claude/settings.json`:

```bash
# In ~/.claude/settings.json, add to "plugins" array:
{
  "plugins": [
    {
      "name": "macrodata",
      "source": "/path/to/macrodata/plugin"
    }
  ]
}
```

## How It Works

1. **Session Start**: The daemon starts (if not running) and connects to macrodata via WebSocket. Full context is injected into the session.

2. **Real-time Updates**: State changes (knowledge, journal entries, schedules) are broadcast via WebSocket and written to a pending file.

3. **Prompt Submit**: Any pending context changes are injected into the conversation.

## Files

The plugin writes to `~/.claude/`:

- `macrodata-daemon.pid` - Daemon process ID
- `macrodata-daemon.log` - Daemon logs
- `macrodata-context.md` - Static context (refreshed on daemon connect)
- `macrodata.json` - Local configuration (optional)
- `pending-context` - Incremental changes from WebSocket events

## Multiple Identities

You can have different Claude identities on different machines while sharing the same memory and human profile.

### 1. Create named identities in macrodata

Use the `save_knowledge` tool to create identities:

```
Type: identity
Name: coding-claude
Content: # Coding Claude
I am a focused software engineering assistant...
```

### 2. Configure per-machine identity

Create `~/.claude/macrodata.json`:

```json
{
  "identity": "coding-claude"
}
```

If no config exists, the default identity from core context is used.

## Authentication

The daemon piggybacks on Claude Code's MCP OAuth tokens stored in the macOS Keychain. Make sure you've authenticated macrodata via `/mcp` before using this plugin.
