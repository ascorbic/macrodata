# Macrodata

<p align="center">
  <img src="https://raw.githubusercontent.com/ascorbic/macrodata/main/logo.webp" alt="Macrodata" width="400">
</p>

A Claude Code and OpenCode plugin that gives it the tools of a stateful agent, packaged so you can still use it for normal work.

- **Layered memory** - identity, journal, semantic search across sessions
- **Scheduling and autonomy** - background tasks, morning prep, maintenance
- **Memory distillation** - consolidates learnings into structured knowledge
- **Dream time** - overnight reflection, pattern recognition, self-improvement
- **No security nightmares** - runs with your existing tools and security rules. No external APIs or third-party skills. Memory stays in local files.

Local-only. Everything stored as markdown and JSON you can read and edit.

## What It Does

Learns and remembers who you are, what you're working on, and how you like to work. Analyses your past conversations to build context. Puts working memory into every session so you never start from scratch.

### Working Memory

Every session starts with context injection - your identity, current projects, daily focus, and recent activity. The agent knows who you are before you type anything.

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
