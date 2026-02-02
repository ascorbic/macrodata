# Macrodata Local Plugin

Local file-based memory for Claude Code. Zero infrastructure, fully offline, optional git tracking.

## Installation

```bash
/plugin marketplace add ascorbic/macrodata
/plugin install macrodata@macrodata
```

## What It Does

1. **Session context injection** - On session start, injects your identity, current state, and recent journal entries
2. **File-based memory** - All state stored as markdown files in `~/.config/macrodata/`
3. **Semantic search** - Search across your journal, entity files, and past conversations
4. **Conversation history** - Search and retrieve context from past Claude Code sessions
5. **Auto-journaling** - Automatically logs git commands and file changes
6. **Session summaries** - Auto-saves conversation summaries before context compaction
7. **Scheduling** - Cron-based and one-shot reminders

## File Structure

```
~/.config/macrodata/
├── identity.md          # Your persona and patterns
├── state/
│   ├── today.md         # Daily focus
│   ├── human.md         # User profile
│   └── workspace.md     # Active projects
├── entities/
│   ├── people/          # One file per person
│   └── projects/        # One file per project
├── journal/             # JSONL, date-partitioned
├── signals/             # Raw events for future analysis
└── .index/
    ├── vectors/         # Memory embeddings
    └── conversations/   # Conversation embeddings
```

## MCP Tools

### Core Memory Tools

| Tool | Purpose |
|------|---------|
| `get_context` | Dynamic context (schedules, recent journal, paths) - static context auto-injected by hooks |
| `log_journal` | Append timestamped entry to journal (auto-indexed for search) |
| `get_recent_journal` | Get recent entries, optionally filtered by topic |
| `log_signal` | Log raw events for later analysis |
| `search_memory` | Semantic search across journal and entities |
| `rebuild_memory_index` | Rebuild the search index from scratch |
| `get_memory_index_stats` | Index statistics |

### Conversation History Tools

| Tool | Purpose |
|------|---------|
| `search_conversations` | Search past Claude Code sessions (project-biased, time-weighted) |
| `expand_conversation` | Load full context from a past conversation |
| `rebuild_conversation_index` | Index Claude Code's conversation logs |
| `get_conversation_index_stats` | Conversation index statistics |

### Session Management Tools

| Tool | Purpose |
|------|---------|
| `save_conversation_summary` | Save session summary for context recovery |
| `get_recent_summaries` | Retrieve recent session summaries |

### Scheduling Tools

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

On first run (no identity.md exists), the plugin will prompt you to set up your identity through conversation:

1. What should the agent call you?
2. Any particular way you'd like it to work with you?
3. What are you working on right now?

The agent will create your identity.md and initial state files.

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
