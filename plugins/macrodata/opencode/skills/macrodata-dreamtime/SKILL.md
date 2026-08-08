---
name: macrodata-dreamtime
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

### Memory File ROI

Read the `Unhelpful files:` and `Helpful files:` lines from the last ~20
`conversation-summary` journal entries. Only a session that used a file can
judge it, so this is the only signal the store has about its own contents.

A path named unhelpful 3+ times has earned a look. Read it against its live
siblings first — the usual cause is a superseded file outranking its own
correction on the same topic, which is a fix, not a removal, and relevance
scores cannot tell those apart.

Correct or merge in place. Do not remove a file here: this run is unattended, so
a wrong call goes uncaught, and writing a file empty leaves an indexed husk that
still outranks its replacement. Journal removal candidates with the evidence
instead, and let an interactive session act on them.

## Output

Update relevant files directly:
- identity.md - role/values refinements
- human.md - new understanding
- workspace.md - open threads
- topics/ - new or updated topics (give each entity a `description:` frontmatter)
- entities/ - project/people updates (add or preserve a `description:` frontmatter — a one-line summary of what the file is)
- journal - learnings, observations, ideas

Write a dreamtime journal entry summarizing:
```
topic: dreamtime
content: [key reflections, what was researched, what was updated]
```
