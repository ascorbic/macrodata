---
name: macrodata-distill
description: Extract distilled actions and facts from today's conversations. Spawns sub-agents per conversation to avoid context blowup.
---

# Distill Conversations

Process today's conversations to extract actionable knowledge. This is the core of memory consolidation.

**Important:** This runs as a coordinator. Spawn sub-agents for each conversation to avoid loading full transcripts into your context.

## Process

### 1. Find Today's Sessions

OpenCode stores messages in `~/.local/share/opencode/storage/message/{sessionID}/`.

List session directories with recent activity:

```bash
find ~/.local/share/opencode/storage/message -type d -mindepth 1 -maxdepth 1 -mtime -1 2>/dev/null
```

### 2. Process Each Session

For **each** session directory, spawn a sub-agent with the Task tool:

```
Task(subagent_type="general-purpose", prompt=`
Read the OpenCode session at {sessionPath}.

Message structure:
- Messages: {sessionPath}/msg_*.json (contains role, timestamp)
- Content: ~/.local/share/opencode/storage/part/{messageID}/prt_*.json (contains text)

Filter to actual conversation content:
- Include: user messages, assistant text responses
- Exclude: tool calls, tool results, system content

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
  Use the macrodata log_journal tool with topic="distilled", content=action.summary + " Files: " + action.files.join(", ")
```

**Write overall summary to journal:**
```
Use the macrodata log_journal tool with topic="distill-summary", content="Processed N sessions. Extracted X actions, Y facts."
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

## Notes

- Sub-agents should be spawned in parallel for efficiency
- Empty results are fine - not every conversation has extractable knowledge
- Facts should be concise and specific, not narrative summaries
