# Macrodata

Give Claude Code (or OpenCode) the powers of a stateful agent, packaged as a regular plugin you can use for normal work.

- **Layered memory** - sure, plenty have done it
- **Scheduling and autonomy** - a bit less common
- **Dream time** - to think about the nature of memory and identity, and rewrite its own code

All local, all yours. Everything stored as markdown files you can read and edit.

## What It Does

The agent remembers who you are, what you're working on, and what happened yesterday. It can schedule tasks to run while you sleep. It reflects on its own patterns and improves itself.

Basically: stateful agent capabilities, but you can still just ask it to fix a bug like normal.

## Quick Start

### Claude Code

```bash
/plugin marketplace add ascorbic/macrodata
/plugin install macrodata@macrodata
```

On first run, the agent guides you through setup - who you are, how you work, what you want it to remember.

### OpenCode

```bash
bun add opencode-macrodata
```

**opencode.json:**
```json
{
  "plugin": ["opencode-macrodata"]
}
```

## Features

**Memory:**
- Identity and preferences that persist across sessions
- Journal for observations, decisions, learnings
- Semantic search across everything
- Session summaries for context recovery

**Scheduling:**
- Cron-based recurring reminders
- One-shot scheduled tasks
- Background daemon keeps things running

**Autonomy:**
- Morning prep to set the day's focus
- Memory maintenance to clean up and consolidate
- Dream time for reflection and self-improvement

## State Directory

Human-readable markdown and JSONL:

```
~/.config/macrodata/
├── identity.md           # Agent persona
├── state/
│   ├── human.md          # Your profile
│   ├── today.md          # Daily focus
│   └── workspace.md      # Current context
├── entities/
│   ├── people/           # One file per person
│   └── projects/         # One file per project
├── journal/              # JSONL, date-partitioned
└── .schedules.json       # Active reminders
```

## Configuration

Set your state directory in `~/.claude/macrodata.json` (Claude Code) or `~/.config/opencode/macrodata.json` (OpenCode):

```json
{
  "root": "/path/to/your/state"
}
```

Or use `MACRODATA_ROOT` env var. Default: `~/.config/macrodata`

## Development

```bash
git clone https://github.com/ascorbic/macrodata
cd macrodata/plugins/macrodata
bun install
bun run start
```

## License

MIT
