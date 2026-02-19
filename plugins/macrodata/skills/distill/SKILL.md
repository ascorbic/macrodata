---
name: distill
description: Extract distilled actions and facts from today's conversations. Spawns sub-agents per conversation to avoid context blowup.
---

# Distill Conversations

Process today's conversations to extract actionable knowledge. This is the core of memory consolidation.

**Important:** This runs as a coordinator. Spawn sub-agents for each conversation file to avoid loading full transcripts into your context.

## Process

### 1. Find Today's Conversations

List conversation files modified today:

```bash
find ~/.claude/projects -name "*.jsonl" -mtime -1 -type f 2>/dev/null
```

### 2. Process Each Conversation

For **each** conversation file, spawn a sub-agent with the Task tool:

```
Task(subagent_type="general-purpose", prompt=`
Read the conversation at {path}.

Filter to actual conversation content:
- Include: human messages, assistant text responses
- Exclude: tool calls, tool results, system messages, thinking blocks

Extract and return as JSON:
{
  "distilled_actions": [
    {
      "summary": "Fixed auth bug in src/auth.ts where token refresh was racing",
      "files": ["src/auth.ts"],
      "outcome": "Added mutex lock around refresh"
    }
  ],
  "facts": [
    {
      "topic": "project-name",
      "content": "Uses JWT tokens with 15min expiry"
    },
    {
      "topic": "person-name",
      "content": "Prefers explicit error handling over try/catch"
    }
  ],
  "decisions": [
    "Chose Redis over in-memory cache for session storage because of multi-instance deployment"
  ]
}

Focus on:
- What was accomplished (not just discussed)
- Decisions made and their rationale
- New information about projects, people, or preferences
- File paths and specific technical details that should survive compression

Return ONLY the JSON, no explanation.
`)
```

### 3. Collect and Write Results

After all sub-agents complete:

**Write distilled actions to journal:**
```
For each action in all results:
  log_journal(topic="distilled", content=action.summary + " Files: " + action.files.join(", "))
```

**Write overall summary to journal:**
```
log_journal(topic="distill-summary", content="Processed N conversations. Extracted X actions, Y facts.")
```

**Update entity files with facts:**
- Group facts by topic
- For each topic, read existing entity file (if any)
- Integrate new facts, removing duplicates
- Write updated file

### 4. Example Sub-Agent Output

```json
{
  "distilled_actions": [
    {
      "summary": "Added /distill skill to macrodata plugin",
      "files": ["plugins/macrodata/skills/distill/SKILL.md"],
      "outcome": "Skill extracts facts from conversations via sub-agents"
    }
  ],
  "facts": [
    {
      "topic": "macrodata",
      "content": "Distillation separates narrative context from retained facts for better compression"
    }
  ],
  "decisions": [
    "Coordinator updates state directly to prevent race conditions from parallel sub-agents"
  ]
}
```

### 4. Commit Memory Changes

After all writes are complete, commit the memory state:

```bash
MACRODATA_ROOT="${MACRODATA_ROOT:-$HOME/.config/macrodata}"
cd "$MACRODATA_ROOT"
git checkout main 2>/dev/null || git checkout -b main
git add -A
git diff --cached --quiet || git commit -m "distill $(date +%Y-%m-%d)"
```

## Notes

- Sub-agents should be spawned in parallel for efficiency
- If a conversation file is very large (>500KB), the sub-agent may need to sample rather than read fully
- Empty results are fine - not every conversation has extractable knowledge
- Facts should be concise and specific, not narrative summaries
