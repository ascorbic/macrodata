---
name: memory-maintenance
description: End of day memory maintenance. Runs distillation, updates state files, prunes stale info. Runs in background with no user interaction.
---

# Memory Maintenance

Scheduled maintenance to keep memory current and useful. Runs automatically at end of day.

**Important:** This runs in the background with no user interaction. Do not ask questions - make decisions and note uncertainties in the journal.

## Process

### 1. Run Distillation

First, run the `/distill` skill to extract facts from today's conversations.

This processes all conversation files, spawns sub-agents for extraction, and writes distilled actions to the journal.

**Check if distill already ran today:**
```bash
grep "distill-summary" ~/.config/macrodata/journal/$(date +%Y-%m-%d).jsonl 2>/dev/null
```

If not found, invoke `/distill`. If already ran, skip to step 2.

### 2. Review Distilled Content

Read the distilled entries from today's journal:
```bash
grep '"topic":"distilled"' ~/.config/macrodata/journal/$(date +%Y-%m-%d).jsonl 2>/dev/null | jq -r '.content'
```

Use these to inform state file updates.

### 3. State File Updates

Review each state file and update if needed:

**today.md**
- Clear completed items
- Note anything that carried over
- Leave empty or minimal for morning prep to fill

**workspace.md**
- Update active projects list based on distilled actions
- Add/remove open threads
- Note any blocked items or waiting-on dependencies

**human.md**
- Any new preferences or patterns from distilled facts?
- Communication style insights?
- Only update if genuinely new information

### 4. Entity Updates

Review `entities/people/` and `entities/projects/`:
- Integrate any facts extracted by distillation
- Project status changes?
- New projects to create files for?

### 5. Prune Stale Info

Look for outdated information:
- Completed todos still listed as active
- Old context that's no longer relevant
- Temporary notes that should be removed
- Duplicated information across files

Remove or archive as appropriate.

### 6. Index Maintenance

Check if indexes need rebuilding:
```
manage_index(target="memory", action="stats")
manage_index(target="conversations", action="stats")
```

If counts seem low or stale, trigger rebuild:
```
manage_index(target="memory", action="rebuild")
manage_index(target="conversations", action="update")
```

### 7. Journal Summary

Write a brief maintenance journal entry:

```
log_journal(topic="maintenance", content="[what was updated, what was pruned, any observations]")
```

Note anything uncertain that should be confirmed with the user next session.

### 8. Commit Memory Changes

After all writes are complete, commit the memory state:

```bash
MACRODATA_ROOT="${MACRODATA_ROOT:-$HOME/.config/macrodata}"
cd "$MACRODATA_ROOT"
git checkout main 2>/dev/null || git checkout -b main
git add -A
git diff --cached --quiet || git commit -m "memory maintenance $(date +%Y-%m-%d)"
```
