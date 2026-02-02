# Macrodata

Persistent memory for AI coding agents. Works with **Claude Code** and **OpenCode**.

Local-first, privacy-preserving, and fully offline. All your data stays on your machine.

## Features

- **Session context injection** - Identity, state, and recent history injected automatically
- **Journal** - Append-only log for observations, decisions, and learnings
- **Semantic search** - Vector search across journal and entity files using Transformers.js
- **Conversation history** - Search and retrieve context from past sessions
- **Auto-journaling** - Git commands and file changes logged automatically
- **Session summaries** - Context recovery across sessions
- **Scheduled reminders** - Cron-based recurring and one-shot reminders
- **Human-readable** - All state stored as markdown files you can edit directly

## Quick Start

### OpenCode

```bash
# Install the plugin
bun add opencode-macrodata

# Or add to opencode.json
```

**opencode.json:**
```json
{
  "plugin": ["opencode-macrodata"]
}
```

Set your state directory:
```bash
export MACRODATA_ROOT="$HOME/.config/macrodata"
```

### Claude Code

```bash
/plugin marketplace add ascorbic/macrodata
/plugin install macrodata@macrodata
```

On first run, the agent will guide you through setting up your identity and preferences.

## State Directory

All state stored as markdown/JSONL files:

```
~/.config/macrodata/
├── identity.md           # Agent persona
├── state/
│   ├── human.md          # Your profile and preferences
│   ├── today.md          # Daily focus
│   ├── workspace.md      # Current project context
│   └── topics.md         # Working knowledge index
├── entities/
│   ├── people/           # One file per person
│   └── projects/         # One file per project
├── journal/              # JSONL, date-partitioned
├── .schedules.json       # Reminders config
└── .index/               # Vectra embeddings cache
```

## How It Works

### OpenCode Plugin

The `opencode-macrodata` plugin provides:

| Feature | Implementation |
|---------|---------------|
| Context injection | `chat.message` hook - injects identity, today, recent journal on first message |
| Compaction survival | `experimental.session.compacting` hook - preserves memory during compaction |
| Auto-journaling | `tool.execute.before` hook - logs git commands and file changes |
| Memory operations | `macrodata` custom tool with modes: journal, summary, remind, read, list |

### Claude Code Plugin

The Claude Code plugin provides MCP tools and hooks:

**MCP Tools:**
| Tool | Purpose |
|------|---------|
| `log_journal` | Append timestamped entry (auto-indexed) |
| `get_recent_journal` | Get recent entries |
| `search_memory` | Semantic search across all memory |
| `search_conversations` | Search past sessions (project-biased) |
| `save_conversation_summary` | Save session summary |
| `schedule_reminder` | Create cron-based reminder |
| `schedule_once` | Create one-shot reminder |

**Hooks:**
| Hook | Behavior |
|------|----------|
| `SessionStart` | Start daemon, inject context |
| `PreCompact` | Auto-save conversation summary |
| `SessionEnd` | Save summary if significant work done |
| `PostToolUse` | Auto-log git commands and file changes |

## Configuration

**OpenCode** - Create `~/.config/opencode/macrodata.json`:
```json
{
  "root": "/path/to/your/state"
}
```

Or set `MACRODATA_ROOT` environment variable.

**Claude Code** - Create `~/.claude/macrodata.json`:
```json
{
  "root": "/path/to/your/state"
}
```

Default location: `~/.config/macrodata`

## Architecture

```
macrodata/
├── plugins/
│   ├── local/              # Claude Code plugin
│   │   ├── src/            # MCP server
│   │   ├── opencode/       # OpenCode plugin (published as opencode-macrodata)
│   │   ├── hooks/          # Claude Code hooks
│   │   └── bin/            # Daemon and scripts
│   └── cloud/              # Cloud plugin (WIP)
└── workers/
    └── macrodata/          # Cloudflare Worker for cloud mode (WIP)
```

### Local vs Cloud

| Aspect | Local | Cloud (WIP) |
|--------|-------|-------------|
| Storage | Local files | Cloudflare R2 + D1 |
| Search | Vectra + Transformers.js | Vectorize |
| Privacy | 100% local | Self-hosted |
| Sync | Git (optional) | Multi-device |
| Features | Full | + Web search, background AI |

## Development

```bash
# Clone
git clone https://github.com/ascorbic/macrodata
cd macrodata

# Local plugin
cd plugins/local
bun install
bun run start  # Run MCP server

# OpenCode plugin
cd plugins/local/opencode
bun install
bun run build
```

## License

MIT
