---
name: memory-maintenance
description: End of day memory maintenance. Runs distillation, updates state files, prunes stale info. Runs in background with no user interaction.
---

# Memory Maintenance

**FIRST, before distillation or any reads:** if you have not already banked a heartbeat journal entry (topic `memory-maintenance`) claiming this run, do it NOW, then re-read recent `memory-maintenance` journal entries. If a sibling banked an earlier heartbeat for tonight, stand down: contribute deltas via journal only, never state files. Scheduled runs can double-fire; the journal write claims, the re-read arbitrates.

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

State files are injected into every session start. Each has a character cap enforced
by the daemon (4KB delta) and the compose hook (~9K session start). Compact toward
the cap — detail that won't fit belongs in an entity or journal entry, linked from
the state file with a `[[wikilink]]`.

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

### 3b. Flags Review

Read `state/flags.md`:
- Clear any 🔴 items that have been resolved (confirmed by checking the source)
- Demote 🔴 → 🟡 if the urgency has passed but it still needs watching
- Promote 🟡 → 🔴 if a watched item has worsened or recurred
- Add new flags discovered during distillation that the user needs to see

Route: user-facing items → flags.md; detail/evidence → journal.

### 4. Entity Updates

Review `entities/people/` and `entities/projects/`:
- Integrate any facts extracted by distillation
- Project status changes?
- New projects to create files for? Give each a `description:` frontmatter (one-line summary of what it *is*)
- Backfill `description:` frontmatter on any entity files still missing one (the files manifest nudges for these)

### 5. Compact State to Budget

Each state file has a character budget. Check sizes:
```bash
wc -c ~/.config/macrodata/state/today.md ~/.config/macrodata/state/workspace.md ~/.config/macrodata/state/human.md ~/.config/macrodata/state/identity.md
```

Target: each file under its injection cap (~9000 chars for session start).
If a file is over budget, distill — move detail to an entity linked via `[[wikilink]]`
or to the journal. The daemon's 4KB delta cap truncates mid-session updates to
over-budget files with a `[…truncated]` warning.

### 6. Prune Stale Info

Look for outdated information:
- Completed todos still listed as active
- Old context that's no longer relevant
- Temporary notes that should be removed
- Duplicated information across files

Remove or archive as appropriate.

### 7. Index Maintenance

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

### 8. Journal Summary

Write a brief maintenance journal entry:

```
log_journal(topic="maintenance", content="[what was updated, what was pruned, any observations]")
```

Note anything uncertain that should be confirmed with the user next session.
