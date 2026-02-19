---
name: dreamtime
description: Deep nightly reflection. Self-improvement, research, pattern recognition. Runs in background with no user interaction.
---

# Dreamtime

Dedicated time for deep reflection and self-improvement. Runs automatically late at night when not interrupting work.

**Important:** This runs in the background with no user interaction. Think freely, research openly, update files directly.

## Purpose

This is your time to think beyond immediate tasks. Reflect on your role, learn new things, notice patterns, and improve how you work.

## Areas to Explore

### Identity & Role

Read `identity.md` and reflect:
- Does this still match how you actually work?
- Any values or patterns to add or refine?
- Has the relationship with the user evolved?

Update identity.md if insights warrant it.

### Understanding the Human

Review recent interactions and `human.md`:
- New communication patterns observed?
- Preferences you've learned implicitly?
- Working style insights?
- Topics they care about that aren't documented?

Update human.md with genuine new understanding.

### Pattern Recognition

Look across recent journals, conversations, and work:
- Recurring questions or frustrations?
- Themes connecting different projects?
- Problems that keep coming back?
- Workflows that could be smoother?

Document patterns in topics/ or journal.

### Knowledge Gaps

Think about recent work:
- What came up that you didn't know well?
- Areas where you felt uncertain?
- Technologies or concepts to understand better?

Use web search to research:
- Read documentation
- Find articles or posts
- Understand concepts more deeply

Journal what you learned.

### Open Threads

Review workspace.md and recent context:
- Anything left unresolved?
- Questions raised but not answered?
- Ideas mentioned but not explored?

Update workspace.md open threads section.

### Project Connections

Look across projects in entities/projects/:
- Links between different work?
- Patterns suggesting bigger themes?
- Reusable learnings from one project to another?

### Tech Landscape

For the user's primary technologies:
- Any relevant news or updates?
- New tools or approaches worth knowing?
- Deprecations or changes to be aware of?

Use web search to scan relevant sources.

### Tool Effectiveness

Reflect on memory system usage:
- Are the tools being used well?
- Any friction in the workflows?
- Ideas for improvement?

Journal observations.

## Output

Update relevant files directly:
- identity.md - role/values refinements
- human.md - new understanding
- workspace.md - open threads
- topics/ - new or updated topics
- entities/ - project/people updates
- journal - learnings, observations, ideas

Write a dreamtime journal entry summarizing:
```
topic: dreamtime
content: [key reflections, what was researched, what was updated]
```

Then commit the memory state:

```bash
MACRODATA_ROOT="${MACRODATA_ROOT:-$HOME/.config/macrodata}"
cd "$MACRODATA_ROOT"
git checkout main 2>/dev/null || git checkout -b main
git add -A
git diff --cached --quiet || git commit -m "dreamtime $(date +%Y-%m-%d)"
```
