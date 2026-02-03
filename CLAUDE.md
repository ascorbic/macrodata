# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Structure

```
macrodata/
└── plugins/
    └── local/                  # Local file-based memory plugin
        ├── .claude-plugin/     # Plugin metadata
        ├── bin/                # Daemon and hook scripts
        ├── skills/             # Plugin skills (e.g., onboarding)
        ├── opencode/           # OpenCode plugin variant
        └── src/                # MCP server source
            ├── index.ts        # MCP server with tool definitions
            ├── indexer.ts      # Vectra indexing logic
            └── embeddings.ts   # Transformers.js embeddings
```

## Build and Development Commands

```bash
# From plugins/local/
bun install
bun run start       # Run MCP server
```

## Architecture

Macrodata provides persistent memory for AI coding agents. File-based, fully offline.

**Source** (`plugins/local/`):
- `src/index.ts` - MCP server with 11 tools (log_journal, search_memory, etc.)
- `src/indexer.ts` - Vectra-based vector index for semantic search
- `src/embeddings.ts` - Transformers.js embedding generation (BGE model)
- `bin/macrodata-daemon.ts` - Background daemon for scheduled reminders

**Storage** (default `~/.config/macrodata/`):
- `identity.md` - Agent persona
- `state/` - Current state (human.md, today.md, workspace.md)
- `entities/` - People, projects as markdown files
- `journal/` - JSONL entries, date-partitioned
- `.index/` - Vectra embeddings cache
