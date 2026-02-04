# Macrodata

<p align="center">
  <img src="https://raw.githubusercontent.com/ascorbic/macrodata/main/logo.webp" alt="Macrodata" width="400">
</p>

Give Claude Code and OpenCode persistent, self-maintaining memory and autonomous scheduling.

> This is experimental software. Use at your own risk.

- **Layered memory** - identity, journal, topics, semantic search across sessions
- **Scheduling and autonomy** - recurring background tasks, reminders, morning prep, self-maintenance
- **Memory distillation** - consolidates learnings into structured knowledge
- **Dream time** - overnight reflection, pattern recognition, self-improvement
- **Uses your existing tools** – no new APIs or third-party skills needed, but if you have them, it can use them.
- **No security nightmares** - runs with your existing security rules. No external APIs or third-party skills.
- **Local-only** - all memories stored as markdown and JSON you can read and edit.

## What It Does

Learns and remembers who you are, what you're working on, and how you like to work. Analyzes your past conversations to build context. Puts working memory into every session so you never start from scratch.

### Working Memory

Every session starts with context injection - your identity, current projects, daily focus, and recent activity. The agent knows who you are and what you're doing before you type anything.

State files track what matters right now:
- **identity.md** - how the agent should behave with you
- **human.md** - who you are, your preferences, your projects
- **today.md** - daily focus and priorities
- **workspace.md** - current project context
- **topics** - working knowledge the agent has built up

### Journals

Observations, decisions, and learnings get logged to a searchable journal. Semantic search finds relevant context across all your history - journal entries, entity files, and past conversations.

### Conversation Analysis

Indexes your past Claude Code and OpenCode sessions. When you're stuck on something similar to before, it finds and retrieves the relevant context from previous conversations.

### Distillation

Periodically consolidates scattered learnings into structured knowledge. Patterns noticed across conversations become permanent understanding in your state files.

### Dream Time

Scheduled reflection that runs while you're away. Reviews recent activity, notices patterns, updates state files, and prepares for tomorrow. Researches best practices. The agent maintains itself.

## Security

Some autonomous agent systems run their own shell, execute third-party skills, and expose APIs - creating prompt injection vectors, credential leaks, and remote code execution risks.

Macrodata runs inside Claude Code's existing permission model. It uses only the tools you've already installed and approved. No external APIs, no third-party skill downloads, no new attack surface. Scheduled tasks run through the same Claude Code instance with the same permissions you've already granted.

The daemon is a simple cron runner that spawns Claude Code when reminders fire. All state is local markdown files. Nothing phones home.

## Installation

### Claude Code

```bash
/plugin marketplace add ascorbic/macrodata
/plugin install macrodata@macrodata
```

### OpenCode

**~/.config/opencode/opencode.json:**
```json
{
  "plugin": ["@macrodata/opencode"]
}
```

Launch the app and ask to set up Macrodata.

## License

MIT
