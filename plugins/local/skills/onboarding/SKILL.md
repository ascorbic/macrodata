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

### Phase 1: Location

Ask where to store macrodata files. Suggest accessible locations:

1. `~/Documents/macrodata` (easy to find)
2. `~/Repos/macrodata` or `~/code/macrodata` (if they use a code folder)
3. `~/.config/macrodata` (default, hidden)

If they choose a non-default location, note that they'll need to set `MACRODATA_ROOT` in their environment.

### Phase 2: Human Profile

Gather information about the user. Start by detecting what you can from the system:

**Auto-detect from system:**
```bash
# Get system username and full name
whoami
id -F 2>/dev/null || getent passwd $(whoami) | cut -d: -f5 | cut -d, -f1

# Timezone
cat /etc/timezone 2>/dev/null || readlink /etc/localtime | sed 's|.*/zoneinfo/||'

# Git config (name, email)
git config --global user.name
git config --global user.email

# GitHub CLI (if authenticated)
gh api user --jq '.login, .name, .blog' 2>/dev/null
```

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

### Phase 3: Agent Identity

Help define who the agent should be:

**Name and persona:**
- What should the agent be called?
- What's its role? (assistant, partner, specialist)
- Any personality traits?

**Values and patterns:**
- What behaviors should it prioritize?
- How proactive should it be?

Write to `identity.md`:

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

### Phase 4: Initial Workspace

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

### Phase 5: Permissions

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

### Phase 6: Finalize

1. Rebuild the memory index with `rebuild_memory_index`
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
2. `~/Repos/macrodata` (with your code)
3. `~/.config/macrodata` (hidden, default)

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
