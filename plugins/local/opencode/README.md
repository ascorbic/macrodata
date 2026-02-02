# opencode-macrodata

Persistent local memory plugin for [OpenCode](https://opencode.ai) agents.

**Local-first** - all data stays on your machine. No API keys, no cloud, works offline.

## Features

- **Context injection** - Identity, today's focus, and recent journal injected on first message
- **Compaction hook** - Memory context preserved across context compaction
- **Auto-journaling** - Git commands and file changes logged automatically
- **Semantic search** - Vector search over journal, entities, and topics using Transformers.js
- **Conversation history** - Search past OpenCode sessions
- **Reminders** - Cron-based scheduling (requires daemon)

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
├── topics/              # Topic files (working knowledge)
├── journal/             # JSONL entries by date
├── .schedules.json      # Scheduled reminders
└── .index/
    ├── vectors/         # Memory embeddings
    └── oc-conversations/ # Conversation embeddings
```

## Tool Usage

The plugin provides a `macrodata` tool with these modes:

### Search
Semantic search over your memory:
```
macrodata mode:search query:"authentication patterns"
macrodata mode:search query:"debugging tips" searchType:journal count:10
```

### Search Conversations
Search past OpenCode sessions:
```
macrodata mode:search_conversations query:"fixing TypeScript errors"
macrodata mode:search_conversations query:"API design" projectOnly:true
```

### Journal
Log observations, decisions, learnings:
```
macrodata mode:journal topic:"debug" content:"Fixed the null pointer issue by..."
```

### Summary
Save/retrieve conversation summaries:
```
macrodata mode:summary content:"Implemented auth flow" keyDecisions:["Use JWT"] openThreads:["Add refresh tokens"]
macrodata mode:summary  # Get recent summaries
```

### Remind
Schedule reminders (requires daemon running):
```
macrodata mode:remind id:"standup" cronExpression:"0 9 * * 1-5" description:"Daily standup" payload:"Check today.md"
macrodata mode:remind id:"standup"  # Remove reminder
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

### Rebuild Index
Rebuild search indexes after manual file changes:
```
macrodata mode:rebuild_index
```

## How It Differs from Supermemory

| Aspect | opencode-macrodata | opencode-supermemory |
|--------|-------------------|---------------------|
| **Storage** | Local files + Vectra index | Cloud API |
| **Privacy** | 100% local | Data sent to servers |
| **Cost** | Free | API key required |
| **Memory model** | Structured (journal, entities, topics) | Generic blobs |
| **Editability** | Human-readable markdown | Opaque |
| **Scheduling** | Cron-based reminders | None |
| **Conversation history** | Indexed and searchable | None |
| **Search** | Local Transformers.js | Cloud API |

## Hooks

| Hook | Behavior |
|------|----------|
| `chat.message` | Inject context on first message |
| `experimental.session.compacting` | Preserve memory during compaction |
| `tool.execute.before` | Auto-log git commands and file changes |

## Development

```bash
cd plugins/local/opencode
bun install
bun run build
```

Test locally by adding to opencode.json:
```json
{
  "plugin": ["file:///path/to/macrodata/plugins/local/opencode"]
}
```

## License

MIT
