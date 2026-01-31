# Local Macrodata Plugin Design

## Overview

A Claude Code plugin that provides durable memory with zero infrastructure. Files on the user's machine, optional git tracking, fully offline.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Claude Code                                         │
│  ┌───────────────────────────────────────────────┐  │
│  │  MCP Server (spawned on first tool use)       │  │
│  │  - State file read/write                      │  │
│  │  - Journal logging                            │  │
│  │  - Semantic search (Transformers.js)          │  │
│  │  - Context bootstrap                          │  │
│  └───────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
         │
         ▼ spawns on session start
┌─────────────────────────────────────────────────────┐
│  Daemon (long-running)                               │
│  - Scheduled tasks (cron-style reminders)           │
│  - Watches for changes                              │
│  - Can trigger Claude Code via CLI                  │
│  - Uses CLAUDE_CODE_BUN_PATH for Bun runtime        │
└─────────────────────────────────────────────────────┘
         │
         ▼ reads/writes
┌─────────────────────────────────────────────────────┐
│  ~/.config/macrodata/                               │
│  ├── identity.md          (persona, patterns)      │
│  ├── state/                                         │
│  │   ├── inbox.md         (quick capture)          │
│  │   ├── today.md         (daily focus)            │
│  │   └── commitments.md   (active threads)         │
│  ├── entities/                                      │
│  │   ├── people/          (*.md per person)        │
│  │   └── projects/        (*.md per project)       │
│  ├── journal/             (JSONL, date-partitioned) │
│  ├── signals/             (raw events for analysis) │
│  └── .index/              (embeddings cache)        │
└─────────────────────────────────────────────────────┘
```

## Two-Tier Memory Model

### Always-Loaded (injected every invocation)

| File | Purpose | Size target |
|------|---------|-------------|
| `identity.md` | Persona, values, learned patterns | ~100 lines |
| `state/inbox.md` | Quick capture, pending items | ~20 lines |
| `state/today.md` | Daily focus, open threads | ~30 lines |
| `state/commitments.md` | Active commitments | ~40 lines |

These files are small by design. They're the "working memory" that provides continuity across sessions.

### Retrieved On-Demand (via semantic search)

| Source | Content | Indexing |
|--------|---------|----------|
| `journal/*.jsonl` | Timestamped observations, notes | Embedded and searchable |
| `entities/people/*.md` | Information about people | Embedded and searchable |
| `entities/projects/*.md` | Project context and status | Embedded and searchable |

These can grow indefinitely. The agent retrieves relevant context via search.

## Tools

### Design Principle: Use Built-in Tools Where Possible

Claude Code already has excellent filesystem tools (Read, Write, Edit, Glob, Grep). Rather than wrapping these in custom MCP tools, we:

1. **Use FS tools directly** for reading/writing state and entity files
2. **Provide MCP tools only** for things FS tools can't do: context bootstrap, journaling, semantic search, scheduling
3. **Watch for file changes** in the daemon to update the search index when files are modified via FS tools

This keeps the MCP surface small and leverages Claude Code's battle-tested file handling.

### Session Bootstrap

#### `get_context`

Called at session start. Returns everything the agent needs to orient:

```typescript
interface ContextResponse {
  identity: string;           // Full identity.md content
  state: {
    inbox: string;
    today: string;
    commitments: string;
  };
  recentJournal: JournalEntry[];  // Last 5 entries
  schedules: Schedule[];          // Active reminders
  isFirstRun: boolean;            // Trigger setup flow if true
  paths: {
    root: string;             // e.g., ~/.config/macrodata
    state: string;            // e.g., ~/.config/macrodata/state
    entities: string;         // e.g., ~/.config/macrodata/entities
  };
}
```

The `paths` field tells the agent where to find files for direct Read/Edit operations.

If `isFirstRun` is true, the agent should guide the user through identity setup.

### State and Entity Files (Use FS Tools)

**State files** – read/edit directly via Claude Code's built-in tools:
- `~/.config/macrodata/identity.md`
- `~/.config/macrodata/state/inbox.md`
- `~/.config/macrodata/state/today.md`
- `~/.config/macrodata/state/commitments.md`

**Entity files** – read/edit/create directly:
- `~/.config/macrodata/entities/people/*.md`
- `~/.config/macrodata/entities/projects/*.md`

**Discovery** – use Glob to find entities:
- `Glob("~/.config/macrodata/entities/people/*.md")`
- `Glob("~/.config/macrodata/entities/projects/*.md")`

The daemon watches these directories and reindexes files when they change.

### Journaling

#### `log_journal`

Append a timestamped entry to the journal:

```typescript
interface JournalEntry {
  timestamp: string;      // ISO 8601
  topic: string;          // Category/tag
  content: string;        // The actual note
  metadata?: {
    source?: string;      // Where this came from (conversation, cron, etc.)
    intent?: string;      // What the agent was doing
  };
}
```

Entries are stored in date-partitioned JSONL files: `journal/2026-01-31.jsonl`

### Signal Logging

#### `log_signal`

Log events that might matter for later analysis, even if current utility is unclear:

```typescript
interface Signal {
  timestamp: string;      // ISO 8601
  type: string;           // Event type (e.g., "file_edit", "search", "reminder_fired")
  context?: {
    file?: string;        // File involved
    query?: string;       // Search query if relevant
    trigger?: string;     // What triggered this
  };
  raw?: any;              // Arbitrary data for future analysis
}
```

Signals are stored in `signals/YYYY-MM-DD.jsonl`. Not indexed for semantic search – they're raw events for potential future analysis (pattern recognition, behavioral insights, debugging).

**Why log signals?**

Tim's VSM insight: you don't know what will matter until later. Logging liberally means you can:
- Spot patterns in how the agent is used
- Debug issues after the fact
- Train future models on actual usage
- Identify emerging needs before they're explicit

**What to log:**
- File reads/writes (which files, when)
- Searches (what queries, what was retrieved)
- Reminder triggers (what fired, was it useful)
- Context retrievals (what got injected)
- Errors and exceptions
- Session starts/ends

#### `get_recent_journal`

Get the N most recent journal entries (default 10).

### Search

#### `search_memory`

Semantic search across all indexed content:

```typescript
interface SearchParams {
  query: string;          // Natural language query
  type?: 'journal' | 'person' | 'project' | 'all';  // Filter by type
  since?: string;         // Only include items after this date
  limit?: number;         // Max results (default 5)
}
```

Returns ranked results with relevance scores.

### Scheduling

#### `schedule_reminder`

Create a recurring reminder (cron syntax):

```typescript
interface Reminder {
  id: string;
  cronExpression: string;   // e.g., "0 9 * * *" for 9am daily
  description: string;
  payload: string;          // Message to process when triggered
}
```

#### `schedule_once`

Create a one-shot reminder at a specific datetime.

#### `list_reminders`

List all active schedules.

#### `remove_reminder`

Delete a scheduled reminder.

## Indexing Strategy

### What Gets Indexed

1. **Journal entries** – each entry becomes a document
2. **Entity files** – each file becomes a document with metadata (type, name)
3. **Identity file** – NOT indexed (always in context anyway)
4. **State files** – NOT indexed (always in context anyway)

### How Indexing Works

- **Model:** all-MiniLM-L6-v2 via Transformers.js (384-dimensional)
- **Storage:** SQLite with vector similarity (or flat file with brute-force search for simplicity)
- **Update triggers:**
  - On `log_journal`: index the new entry immediately
  - On file change (watched by daemon): reindex the changed file
  - Background: periodic full reindex as fallback

### File Watching

The daemon watches the `entities/` directory for changes:

```typescript
// Daemon watches for file changes
chokidar.watch([
  '~/.config/macrodata/entities/**/*.md',
], {
  ignoreInitial: true,
}).on('all', (event, path) => {
  // Reindex the changed file
  indexFile(path);
});
```

This means the agent can use Claude Code's FS tools to create/edit entity files, and the daemon will automatically pick up the changes and update the search index.

### Index Location

`.index/` directory containing:
- `embeddings.db` – SQLite database with vectors
- `metadata.json` – index version, model info

## Context Injection

The plugin injects context at two levels:

### 1. Global CLAUDE.md Reference

On `SessionStart`, the hook writes the full context to `~/.config/macrodata/.claude-context.md`. This file should be referenced from your global `~/.claude/CLAUDE.md`:

```markdown
# My Global CLAUDE.md

@~/.config/macrodata/.claude-context.md
```

This uses Claude Code's `@path/to/file` import syntax. The context is loaded as part of the system prompt, making it available before any tool calls.

### 2. Session Hook Output

The same context is also output to stdout by the hook, which Claude Code injects into the conversation. This provides redundancy and ensures the context is present even if CLAUDE.md isn't configured.

The context file (`.claude-context.md`) is regenerated on every session start, so it always reflects the current state of identity, inbox, today, and commitments.

## Setup Flow

On first run (`isFirstRun: true`), the agent should:

1. **Create directory structure** with sensible defaults
2. **Guide identity creation** through conversation:
   - "What should I call you?"
   - "Any particular way you'd like me to work with you?"
   - "What are you working on right now?"
3. **Optionally initialize git** for version tracking
4. **Create initial state files** with placeholders

This mirrors how Acme and Innie developed their identities collaboratively rather than from a template.

## Git Integration

Optional but encouraged:

- On state file write: `git add && git commit -m "Update {file}"`
- Allows rollback of accidental changes
- Provides history of how patterns evolved
- Configured via `macrodata.json` settings

## Configuration

`~/.config/macrodata/macrodata.json`:

```json
{
  "git": {
    "enabled": true,
    "autoCommit": true,
    "remote": null
  },
  "search": {
    "model": "all-MiniLM-L6-v2",
    "indexOnWrite": true
  },
  "daemon": {
    "enabled": true,
    "checkInterval": 60000
  }
}
```

## MCP Tool Summary

The plugin provides 11 MCP tools. Everything else uses Claude Code's built-in FS tools.

| Tool | Purpose |
|------|---------|
| `get_context` | Session bootstrap – identity, state, recent journal, schedules, paths |
| `log_journal` | Append timestamped entry + auto-index for search |
| `get_recent_journal` | Get N most recent journal entries |
| `log_signal` | Log raw events for future analysis |
| `search_memory` | Semantic search across journal and entities |
| `rebuild_memory_index` | Rebuild search index from scratch |
| `get_memory_index_stats` | Get statistics about the memory index |
| `schedule_reminder` | Create recurring reminder (cron) |
| `schedule_once` | Create one-shot reminder |
| `list_reminders` | List active schedules |
| `remove_reminder` | Delete a reminder |

**Not MCP tools** (use built-in FS tools):
- Reading/writing state files → `Read`, `Edit`, `Write`
- Reading/writing entity files → `Read`, `Edit`, `Write`
- Finding entity files → `Glob`
- Searching file contents → `Grep`

## What This Doesn't Include

- **Remote sync** – that's the cloud plugin's job
- **Multi-machine coordination** – use the cloud plugin for that
- **Team features** – this is personal memory only

## Migration Path

For users who want to move from local to cloud:

1. Export identity and state files
2. Upload to remote macrodata service
3. Switch plugin configuration

The file formats are compatible between local and cloud.
