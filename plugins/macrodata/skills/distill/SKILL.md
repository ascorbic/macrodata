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

Extract key items, then write them directly to journal using tool calls:

- For each accomplishment/action:
  `log_journal(topic="distilled", content="<action summary> Files: <comma-separated files>. Outcome: <outcome>")`
- For each durable fact:
  `log_journal(topic="distilled-fact", content="[<topic>] <fact content>")`
- For each decision and rationale:
  `log_journal(topic="distilled-decision", content="<decision text>")`

Focus on:
- What was accomplished (not just discussed)
- Decisions made and their rationale
- New information about projects, people, or preferences
- File paths and specific technical details that should survive compression

Return ONLY a short one-line summary, for example:
"Wrote 3 actions, 2 facts, 1 decision to journal."
`)
```

### 3. Collect and Write Results

After all sub-agents complete:

**Write overall summary to journal:**
```
log_journal(topic="distill-summary", content="Processed N conversations. Sub-agents wrote distilled entries directly to journal.")
```

**Read distilled data from journal (instead of parsing large sub-agent payloads):**
- Use `get_recent_journal` to fetch recent entries
- Filter/group by topics: `distilled`, `distilled-fact`, `distilled-decision`
- Update entity/state files from those journal entries

Do not aggregate extracted raw data in coordinator context.

### 4. Example Sub-Agent Output

```text
Wrote 2 actions, 4 facts, 1 decision to journal.
```

## Notes

- Sub-agents should be spawned in parallel for efficiency
- If a conversation file is very large (>500KB), the sub-agent may need to sample rather than read fully
- Sub-agents MUST write to journal themselves and return only a short summary line
- Empty results are fine - not every conversation has extractable knowledge
- Facts should be concise and specific, not narrative summaries
