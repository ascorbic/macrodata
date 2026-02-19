---
name: onboarding
description: Guide new users through macrodata setup. Creates identity, human profile, and workspace files. Use when get_context returns isFirstRun true, or user asks to set up their profile.
---

# Onboarding Skill

Guide new users through initial macrodata setup.

## When to Use

- `get_context` returns `isFirstRun: true`
- User explicitly asks to set up or reset their profile
- State files are empty or missing

## Guidelines

Use `AskUserQuestion` for any choice with multiple options (location, permissions, etc.). This provides a better UX than asking in plain text.

## Onboarding Flow

### Phase 0: Prerequisites

Check that Bun is installed (required for the MCP server):

```bash
command -v bun
```

If not found, offer to install it:

**Ask:** "Macrodata needs Bun to run. Would you like me to install it?"

If yes, run:
```bash
curl -fsSL https://bun.sh/install | bash
```

After installation, verify it worked:
```bash
# Source the updated PATH
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
command -v bun && bun --version
```

If they decline, explain that macrodata won't work without Bun and ask if they'd like to install it manually later.

### Phase 1: User Info

User info has been pre-detected and is available in the context above as "Detected User Info". This JSON contains:
- `username`, `fullName`, `timezone`
- `git.name`, `git.email`
- `github.login`, `github.name`, `github.blog`, `github.bio`
- `codeDirs` - array of existing code directories

Use this data throughout onboarding - no need to run detection scripts.

### Phase 2: Location

Use `AskUserQuestion` to offer location options. Always include:
- `~/Documents/macrodata` - easy to find
- `~/.config/macrodata` - hidden, default

Only include a code directory option if `codeDirs` from the detection was non-empty.

If they choose a non-default location, write it to `~/.config/macrodata/config.json`:

```json
{
  "root": "/path/to/chosen/location"
}
```

After writing the config, signal the daemon to reload:

```bash
kill -HUP $(cat ~/.config/macrodata/.daemon.pid) 2>/dev/null || true
```

Then create the directory structure:
- `<root>/`
- `<root>/state/`
- `<root>/journal/`
- `<root>/entities/`
- `<root>/entities/people/`
- `<root>/entities/projects/`
- `<root>/topics/`

Then initialize git for memory versioning:

```bash
cd "<root>"

# Create .gitignore for runtime/generated files
cat > .gitignore << 'EOF'
.index/
.daemon.log
.daemon.pid
.pending-context
.claude-context.md
.context-lastmod.json
.DS_Store
EOF

git init
git checkout -b main
git add .gitignore
git commit -m "initial: macrodata setup"
```

### Phase 3: Human Profile

Use the info from the detection script to pre-populate.

**Ask the basics:**
- What should I call you? (confirm or correct auto-detected name)
- What's your GitHub username? (if not detected from gh cli)
- Do you have a website or blog?
- Any social profiles you'd like me to know about?

**Research their online presence:**
If they provide a website, socials, or GitHub, fetch and analyze them for:
- Bio and self-description
- What they write about (interests, expertise)
- Tone and voice in their writing
- Projects and work they highlight

This gives context beyond what they explicitly state – understanding who they are publicly helps the agent communicate appropriately.

**Communication style:**
If they consent, analyze their Claude Code session history (`~/.claude/projects/`):

```bash
# Extract human messages from session history
find ~/.claude/projects -name "*.jsonl" -exec cat {} \; 2>/dev/null | \
  jq -r 'select(.type == "human") | .message.content' 2>/dev/null | \
  head -200
```

Look for patterns:
- Message length (short/direct vs detailed)
- Tone (casual, formal, technical)
- How they give feedback (direct corrections, suggestions, questions)
- Language preferences (spelling variants, idioms)

**Current work context:**
Analyze recent session history to understand what they're working on:

```bash
# Get recent project directories from Claude Code history
ls -lt ~/.claude/projects/ | head -10

# Sample recent conversations for context
find ~/.claude/projects -name "*.jsonl" -mtime -7 -exec cat {} \; 2>/dev/null | \
  jq -r 'select(.type == "human") | .message.content' 2>/dev/null | \
  head -100
```

**Working patterns:**
- Ask about current focus areas (or confirm what you detected)
- Any preferences for how the agent should work?

Write findings to `state/human.md`:

```markdown
# Human Profile

## Basics
- **Name:** [name]
- **GitHub:** [username]
- **Website:** [url if provided]
- **Socials:** [any provided]
- **Timezone:** [detected]

## Communication Style
- [observed patterns from analysis]
- [stated preferences]

## Working Patterns
- [current focus areas]
- [preferences]

## Current Projects
- [detected from recent sessions]

## Pending Items
- [empty initially]
```

### Phase 4: Agent Identity

Help define who the agent should be:

**Name and persona:**
- What should the agent be called?
- What's its role? (assistant, partner, specialist)
- Any personality traits?

**Values and patterns:**
- What behaviors should it prioritize?
- How proactive should it be?

Write to `state/identity.md`:

```markdown
# [Agent Name] Identity

## Persona
[Description of who the agent is, its role, personality]

## Values
- [core value 1]
- [core value 2]

## Patterns
- [behavioral pattern 1]
- [behavioral pattern 2]
```

### Phase 5: Initial Workspace

Set up working context:

1. Ask what they're currently working on
2. Create initial project files in `entities/projects/`
3. Write `state/today.md` with current context
4. Write `state/workspace.md` with active projects

```markdown
# Today

## Now
[Current context from conversation]

## Context
[Background information]
```

```markdown
# Workspace

## Active Projects
- [project 1] - [brief description]

## Open Threads
- [things in progress]
```

### Phase 6: Permissions

Ask if they'd like to pre-grant permissions for macrodata paths. This avoids permission prompts every session.

**Ask:** "Would you like me to update your Claude Code settings to pre-grant permissions for macrodata? This means you won't be prompted each time macrodata reads or writes to its memory folder."

If yes, update `~/.claude/settings.json` to add:

```json
{
  "permissions": {
    "allow": [
      "Read(~/.config/macrodata/**)",
      "Edit(~/.config/macrodata/**)",
      "Write(~/.config/macrodata/**)",
      "Read(~/.claude/projects/**)",
      "mcp__plugin_macrodata_macrodata__*"
    ]
  }
}
```

**Important:** Replace `~/.config/macrodata` with their actual chosen root path. The paths should be:
- The macrodata root folder (read/write/edit)
- `~/.claude/projects/` (read only, for conversation history search)
- All macrodata MCP tools (pattern: `mcp__plugin_macrodata_macrodata__*`)

Merge with existing settings rather than overwriting:

```bash
# Read existing settings, merge permissions, write back
jq -s '.[0] * .[1]' ~/.claude/settings.json <(echo '{"permissions":{"allow":["..."]}}') > ~/.claude/settings.json.tmp && mv ~/.claude/settings.json.tmp ~/.claude/settings.json
```

### Phase 7: Scheduled Reminders

**First, check available integrations:**

Look at the tools, skills, and MCP servers available in your current context. Note any that might be useful for scheduled tasks - for example:
- Calendar integrations → could check meetings in morning prep
- Email/messaging tools → could summarize communications
- Task managers → could review todos
- Project management tools → could check status

Don't hardcode specific tool names - just note what categories are available. Mention relevant ones when describing the schedule options below.

**Then offer scheduled reminders:**

Use `AskUserQuestion` to offer optional scheduled reminders. These run in the background with no user interaction.

**Options to offer (multiSelect: true):**

1. **Morning prep** (daily, 9am) - Quick review to set the day's focus. Updates today.md.

2. **Memory maintenance** (daily, 6pm) - End of day cleanup. Reviews journals, updates state files, prunes stale info. Runs the `/memory-maintenance` skill.

3. **Dreamtime** (daily, 2am) - Deep nightly reflection. Self-improvement, research, pattern recognition. Runs the `/dreamtime` skill.

For each selected reminder, use the `schedule` tool to create it. **Important:** For deep thinking tasks (dreamtime, memory maintenance), specify a capable model using the `model` parameter. Choose a model appropriate for reflection and reasoning - the user's most capable available model is best for these tasks.

```
Morning prep:
- id: morning-prep
- type: cron
- expression: 0 9 * * *
- description: Morning prep - update today.md
- payload: Review today.md. What's the focus for today? Any carryover from yesterday? Check if any calendar, email, or task tools are available and use them to see what's planned. Keep it brief.
- model: (optional - default is fine for quick tasks)

Memory maintenance:
- id: memory-maintenance
- type: cron
- expression: 0 18 * * *
- description: End of day memory maintenance
- payload: Run the memory-maintenance skill.
- model: (use a capable model for reflection tasks)

Dreamtime:
- id: dreamtime
- type: cron
- expression: 0 2 * * *
- description: Nightly reflection and self-improvement
- payload: Run the dreamtime skill.
- model: (use the most capable available model for deep thinking)
```

### Phase 8: Finalize

1. Rebuild the memory index with `manage_index`
2. Log completion to journal
3. Summarize what was created
4. Suggest next steps

## Session History Analysis

If the user consents, analyze their Claude Code history for communication patterns:

```bash
# Count messages and get stats
find ~/.claude/projects -name "*.jsonl" -exec cat {} \; 2>/dev/null | \
  jq -r 'select(.type == "human") | .message.content' 2>/dev/null | \
  awk '{print length}' | \
  sort -n | \
  awk '{sum+=$1; a[NR]=$1} END {print "Messages:", NR, "Median:", a[int(NR/2)], "Avg:", int(sum/NR)}'
```

**Useful patterns to extract:**
- Message length distribution (short = direct communicator)
- Greeting patterns (casual vs formal)
- How they give corrections ("no" vs "actually" vs questions)
- Technical depth (jargon usage)
- Language patterns (spelling, idioms, formality)

Summarize only actionable patterns for the human profile.

**Context to extract:**
- Recent project directories they've been working in
- Common file types and technologies
- Recurring themes or topics

## Example Conversation

**Agent:** Welcome to macrodata! Let's get you set up.

First, where would you like me to store your memory files?
1. `~/Documents/macrodata` (easy to find in Finder)
2. `~/.config/macrodata` (hidden, default)

_[If a code directory like ~/Code or ~/Projects exists, also offer that as an option]_

**User:** Documents is fine

**Agent:** Got it. Now, what should I call you?

**User:** Matt

**Agent:** I can see from your system that you're [name from git config], GitHub username [from gh cli], and you're in the [timezone] timezone. Is that right?

**User:** Yeah

**Agent:** Do you have a website or any social profiles you'd like me to know about?

**User:** My blog is example.com

**Agent:** Got it. Would you like me to analyze your Claude Code session history to understand your communication style and what you've been working on? I'll look at things like how you communicate and recent projects. This stays completely local.

**User:** Sure

**Agent:** [runs analysis, summarizes findings]

Looking at your history, I can see you communicate in short, direct messages, give quick acknowledgments, and tend to ask questions before committing to an approach. You've been working on [detected projects] recently.

Now, what would you like to call your agent?

[continues through flow...]
