---
name: macrodata-distill
description: Extract distilled actions and facts from today's conversations. Spawns sub-agents per conversation to avoid context blowup.
---

# Distill Conversations

Process today's conversations to extract actionable knowledge. This is the core of memory consolidation.

**Important:** This runs as a coordinator. Spawn sub-agents for each conversation to avoid loading full transcripts into your context.

## Storage Format

OpenCode stores all session data in a SQLite database at `~/.local/share/opencode/opencode.db`.

**Schema:**
- `session` — id, project_id, parent_id, title, time_created, time_updated
- `message` — id, session_id, time_created, data (JSON: role, agent, modelID, etc.)
- `part` — id, message_id, session_id, time_created, data (JSON: type, text, etc.)
- `project` — id, worktree, name

**Part types:** text, tool, step-start, step-finish, patch, reasoning, compaction, file, subtask

**Key JSON paths:**
- `message.data` → `$.role` (user/assistant), `$.summary` (set on compaction messages)
- `part.data` → `$.type` (text/tool/etc.), `$.text` (for text parts)

## Process

### 1. Find Today's Sessions

Query the SQLite database for sessions with activity today. Exclude subtask sessions (parent_id IS NOT NULL).

```bash
sqlite3 ~/.local/share/opencode/opencode.db "
  SELECT s.id, s.title, p.worktree, s.time_created
  FROM session s
  LEFT JOIN project p ON p.id = s.project_id
  WHERE s.parent_id IS NULL
    AND s.time_updated > unixepoch('now', '-1 day') * 1000
  ORDER BY s.time_updated DESC
"
```

### 2. Process Each Session

For **each** session, spawn a sub-agent with the Task tool:

```
Task(subagent_type="general", prompt=`
Read an OpenCode conversation from the SQLite database at ~/.local/share/opencode/opencode.db.

Session ID: {sessionId}
Session title: {sessionTitle}
Project: {projectWorktree}

Use this query to extract the conversation (user prompts and assistant text responses):

sqlite3 ~/.local/share/opencode/opencode.db "
  SELECT
    m.id AS message_id,
    json_extract(m.data, '$.role') AS role,
    m.time_created,
    GROUP_CONCAT(
      CASE WHEN json_extract(p.data, '$.type') = 'text'
        THEN json_extract(p.data, '$.text')
      END,
      char(10)
    ) AS text_content
  FROM message m
  JOIN part p ON p.message_id = m.id
  WHERE m.session_id = '{sessionId}'
    AND json_extract(m.data, '$.role') IN ('user', 'assistant')
    AND json_extract(m.data, '$.summary') IS NULL
  GROUP BY m.id
  HAVING text_content IS NOT NULL AND text_content != ''
  ORDER BY m.time_created ASC
"

Filter to actual conversation content:
- Include: user messages, assistant text responses
- Exclude: tool calls, tool results, system content, compaction summaries

Extract key items, then write them directly to journal using tool calls:

- For each accomplishment/action:
  `macrodata_log_journal(topic="distilled", content="<action summary> Files: <comma-separated files>. Outcome: <outcome>")`
- For each durable fact:
  `macrodata_log_journal(topic="distilled-fact", content="[<topic>] <fact content>")`
- For each decision and rationale:
  `macrodata_log_journal(topic="distilled-decision", content="<decision text>")`

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
macrodata_log_journal(topic="distill-summary", content="Processed N sessions. Sub-agents wrote distilled entries directly to journal.")
```

**Read distilled data from journal (instead of parsing large sub-agent payloads):**
- Use `macrodata_get_recent_journal` to fetch recent entries
- Filter/group by topics: `distilled`, `distilled-fact`, `distilled-decision`
- Update entity/state files from those journal entries

Do not aggregate extracted raw data in coordinator context.

### 4. Example Sub-Agent Output

```text
Wrote 2 actions, 4 facts, 1 decision to journal.
```

## Notes

- Sub-agents should be spawned in parallel for efficiency
- Sub-agents MUST write to journal themselves and return only a short summary line
- Empty results are fine - not every conversation has extractable knowledge
- Facts should be concise and specific, not narrative summaries
