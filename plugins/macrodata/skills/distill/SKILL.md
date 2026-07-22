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

**First, extract clean conversation text.** Run the bundled `jq` filter to convert each
raw transcript to human + assistant text only. It keeps just the text blocks — dropping
tool calls, tool results, thinking blocks, and harness plumbing (slash-command echoes,
`<usage>` telemetry) — and shrinks a transcript ~44x. Write the output to a temp dir,
not the cwd:

```bash
scratch="$(mktemp -d)"
for conversation in $CONVERSATIONS; do
  jq -rn -f "${CLAUDE_PLUGIN_ROOT}/bin/transcript-text.jq" "$conversation" \
    > "$scratch/$(basename "$conversation" .jsonl).txt"
done
```

Then for **each** extracted text file, spawn a sub-agent with the Task tool:

```
Task(subagent_type="general-purpose", prompt=`
Read the conversation transcript at {clean_text_path}. It is already filtered to
human + assistant messages only — no tool calls, tool results, or thinking blocks.

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
- Write updated file — ensure it has a `description:` frontmatter (a one-line summary of what the entity *is*); add one if missing, preserve it if present

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
- Clean up the temp dir once all sub-agents finish: `rm -rf "$scratch"`
- Extraction shrinks a transcript ~44x, so the clean text is almost always readable in
  full; only a genuinely enormous session (a multi-MB extract) needs sampling
- Requires `jq` (install with `brew install jq` if missing)
- Empty results are fine - not every conversation has extractable knowledge
- Facts should be concise and specific, not narrative summaries
