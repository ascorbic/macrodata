# Macrodata

A Claude Code and OpenCode plugin that gives it the tools of a stateful agent, packaged so you can still use it for normal work.

- **Layered memory** - identity, journal, semantic search across sessions
- **Scheduling and autonomy** - background tasks, morning prep, maintenance
- **Dream time** - overnight reflection, pattern recognition, self-improvement
- **No security nightmares** - runs with your existing tools and security rules. No external APIs or third-party skills. Memory stays in local files.

Local-first. Everything stored as markdown you can read and edit.

## What It Does

Remembers who you are, what you're working on, what happened yesterday. Schedules tasks to run while you sleep. Reflects on its own patterns and improves itself.

Works inside your normal coding workflow. No separate agent system to run, no new interface to learn. Open Claude Code, do your work, close it. The memory persists.

Most memory plugins store and retrieve context. This one has agency - it runs tasks on a schedule, maintains itself, and evolves over time.

## Security

Some autonomous agent systems run their own shell, execute third-party skills, and expose APIs - creating prompt injection vectors, credential leaks, and remote code execution risks.

Macrodata runs inside Claude Code's existing permission model. It uses only the tools you've already installed and approved. No external APIs, no third-party skill downloads, no new attack surface. Scheduled tasks run through the same Claude Code instance with the same permissions you've already granted.

The daemon is a simple cron runner that spawns Claude Code when reminders fire. All state is local markdown files. Nothing phones home.

## Quick Start

### Claude Code

```bash
/plugin marketplace add ascorbic/macrodata
/plugin install macrodata@macrodata
```

First run guides you through setup.

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
- Identity and preferences persist across sessions
- Journal for observations, decisions, learnings
- Semantic search across everything
- Session summaries for context recovery

**Scheduling:**
- Cron-based recurring reminders
- One-shot scheduled tasks
- Background daemon

**Autonomy:**
- Morning prep to set daily focus
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

State directory: `~/.claude/macrodata.json` (Claude Code) or `~/.config/opencode/macrodata.json` (OpenCode):

```json
{
  "root": "/path/to/your/state"
}
```

Or `MACRODATA_ROOT` env var. Default: `~/.config/macrodata`

## Development

```bash
git clone https://github.com/ascorbic/macrodata
cd macrodata/plugins/macrodata
bun install
bun run start
```

## License

MIT
