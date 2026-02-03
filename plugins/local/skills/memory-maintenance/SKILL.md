---
name: memory-maintenance
description: End of day memory maintenance. Review journals, update state files, prune stale info. Runs in background with no user interaction.
---

# Memory Maintenance

Scheduled maintenance to keep memory current and useful. Runs automatically at end of day.

**Important:** This runs in the background with no user interaction. Do not ask questions - make decisions and note uncertainties in the journal.

## Process

### 1. Review Recent Activity

Read the day's journal entries:
```bash
cat ~/.config/macrodata/journal/$(date +%Y-%m-%d).jsonl 2>/dev/null | jq -r '.topic + ": " + .content'
```

Also check recent conversation summaries for context.

### 2. State File Updates

Review each state file and update if needed:

**today.md**
- Clear completed items
- Note anything that carried over
- Leave empty or minimal for morning prep to fill

**workspace.md**
- Update active projects list based on recent work
- Add/remove open threads
- Note any blocked items or waiting-on dependencies

**human.md**
- Any new preferences or patterns observed?
- Communication style insights?
- Only update if genuinely new information

### 3. Topic Management

Check `topics/` directory. For each active topic:
- Is the information still current?
- Should anything be added from today's work?
- Any topics to archive or merge?

Create new topic files if a subject came up repeatedly.

### 4. Entity Updates

Review `entities/people/` and `entities/projects/`:
- Any new information about people worked with?
- Project status changes?
- New projects to create files for?

### 5. Prune Stale Info

Look for outdated information:
- Completed todos still listed as active
- Old context that's no longer relevant
- Temporary notes that should be removed
- Duplicated information across files

Remove or archive as appropriate.

### 6. Journal Summary

Write a brief maintenance journal entry:

```
topic: maintenance
content: [what was updated, what was pruned, any observations]
```

Note anything uncertain that should be confirmed with the user next session.
