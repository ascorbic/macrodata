# Macrodata Local Plugin

Local file-based memory for **Claude Code**. Zero infrastructure, fully offline.

> **Using OpenCode?** See [opencode-macrodata](./opencode/) for the OpenCode plugin.

## Installation

```bash
/plugin marketplace add ascorbic/macrodata
/plugin install macrodata@macrodata
```

## What It Does

1. **Session context injection** - On session start, injects your identity, current state, and recent journal
2. **File-based memory** - All state stored as markdown files in `~/.config/macrodata/`
3. **Semantic search** - Search across journal, entity files, and past conversations
4. **Conversation history** - Search and retrieve context from past Claude Code sessions
5. **Auto-journaling** - Automatically logs git commands and file changes
6. **Session summaries** - Auto-saves conversation summaries before context compaction
7. **Scheduling** - Cron-based and one-shot reminders

## File Structure

```
~/.config/macrodata/
├── state/
│   ├── identity.md      # Agent persona
│   ├── today.md         # Daily focus
│   ├── human.md         # User profile
│   ├── workspace.md     # Current project context
│   └── topics.md        # Working knowledge index
├── entities/
│   ├── people/          # One file per person
│   └── projects/        # One file per project
├── journal/             # JSONL, date-partitioned
├── signals/             # Raw events for future analysis
├── .schedules.json      # Reminders config
└── .index/
    ├── vectors/         # Memory embeddings
    └── conversations/   # Conversation embeddings
```

## MCP Tools

### Core Memory

| Tool | Purpose |
|------|---------|
| `get_context` | Paths and dynamic context (schedules, recent journal) |
| `log_journal` | Append timestamped entry (auto-indexed for search) |
| `get_recent_journal` | Get recent entries, optionally filtered by topic |
| `log_signal` | Log raw events for later analysis |
| `search_memory` | Semantic search across journal and entities |
| `rebuild_memory_index` | Rebuild the search index from scratch |
| `get_memory_index_stats` | Index statistics |

### Conversation History

| Tool | Purpose |
|------|---------|
| `search_conversations` | Search past sessions (project-biased, time-weighted) |
| `expand_conversation` | Load full context from a past conversation |
| `rebuild_conversation_index` | Index Claude Code's conversation logs |
| `get_conversation_index_stats` | Conversation index statistics |

### Session Management

| Tool | Purpose |
|------|---------|
| `save_conversation_summary` | Save session summary for context recovery |
| `get_recent_summaries` | Retrieve recent session summaries |

### Scheduling

| Tool | Purpose |
|------|---------|
| `schedule_reminder` | Create recurring reminder (cron) |
| `schedule_once` | Create one-shot reminder |
| `list_reminders` | List active schedules |
| `remove_reminder` | Delete a reminder |

## Hooks

The plugin uses Claude Code hooks for automatic behavior:

| Hook | Behavior |
|------|----------|
| `SessionStart` | Start daemon, inject context |
| `UserPromptSubmit` | Inject pending reminders |
| `PreCompact` | Auto-save conversation summary before compaction |
| `SessionEnd` | Save summary if significant work was done |
| `PostToolUse` (Bash) | Auto-log git commands |
| `PostToolUse` (Write/Edit) | Auto-log file changes |

## First Run

On first run (no `state/identity.md` exists), the plugin will prompt you to set up your identity:

1. What should the agent call you?
2. Any particular way you'd like it to work with you?
3. What are you working on right now?

The agent will create your `state/identity.md` and initial state files.

## Configuration

To use a custom storage directory, create `~/.claude/macrodata.json`:

```json
{
  "root": "/path/to/your/macrodata"
}
```

Default location is `~/.config/macrodata`.

## Daemon

A background daemon handles:
- Scheduled reminders (cron and one-shot)
- File watching for index updates

The daemon is automatically started by the hook script on session start.

## Development

```bash
cd plugins/macrodata
bun install

# Run MCP server
bun run start

# Run daemon
bun run daemon

# Type check
bun run check
```
