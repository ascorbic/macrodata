# opencode-macrodata

Persistent local memory plugin for [OpenCode](https://opencode.ai) agents.

**Local-first** - all data stays on your machine. No API keys, no cloud, works offline.

## Features

- **Context injection** - Identity, today's focus, and recent journal injected on first message
- **Compaction hook** - Memory context preserved across context compaction
- **Auto-journaling** - Git commands and file changes logged automatically
- **Custom tool** - `macrodata` tool for journaling, summaries, reminders, and more

## Installation

```bash
# Add to your OpenCode config
```

**opencode.json:**
```json
{
  "plugin": ["opencode-macrodata"]
}
```

**Set state directory** (env var or config file):

```bash
export MACRODATA_ROOT="$HOME/.config/macrodata"
```

Or create `~/.config/opencode/macrodata.json`:
```json
{
  "root": "/path/to/your/state/directory"
}
```

## State Directory Structure

```
$MACRODATA_ROOT/
├── identity.md          # Agent persona
├── state/
│   ├── today.md         # Daily focus
│   ├── human.md         # User info
│   ├── workspace.md     # Current project context
│   └── topics.md        # Working knowledge index
├── entities/
│   ├── people/          # People as markdown files
│   └── projects/        # Projects as markdown files
├── journal/             # JSONL entries by date
└── .schedules.json      # Scheduled reminders
```

## Tool Usage

The plugin provides a `macrodata` tool with these modes:

### Journal
```
macrodata mode:journal topic:"debug" content:"Fixed the null pointer issue by..."
```

### Summary
Save conversation summaries for context recovery:
```
macrodata mode:summary content:"Implemented auth flow" keyDecisions:["Use JWT"] openThreads:["Add refresh tokens"]
```

### Remind
Schedule reminders (requires daemon running):
```
macrodata mode:remind id:"standup" cronExpression:"0 9 * * 1-5" description:"Daily standup" payload:"Check today.md for priorities"
```

### Read
Read state files:
```
macrodata mode:read file:"today"
macrodata mode:read file:"identity"
```

### List
```
macrodata mode:list listType:"journal" count:10
macrodata mode:list listType:"reminders"
macrodata mode:list listType:"summaries"
```

## How It Differs from Supermemory

| Aspect | opencode-macrodata | opencode-supermemory |
|--------|-------------------|---------------------|
| **Storage** | Local files + Vectra index | Cloud API |
| **Privacy** | 100% local | Data sent to servers |
| **Cost** | Free | API key required |
| **Memory model** | Structured (journal, entities, topics) | Generic blobs |
| **Editability** | Human-readable markdown | Opaque |
| **Reminders** | Cron-based scheduling | None |

## Development

```bash
cd plugins/local/opencode
bun install
bun run build
```

Test locally:
```json
{
  "plugin": ["file:///path/to/macrodata/plugins/local/opencode"]
}
```

## License

MIT
