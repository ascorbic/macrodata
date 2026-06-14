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

State files are a bounded working set, not a log. Each has a budget (a screenful); content over budget is truncated at injection, so a bloated file helps no one. **The detail belongs in the journal and entity files — state holds only what's live and load-bearing now, each item a one-line status with a pointer to where the detail lives.** Updating state means as much cutting as adding.

**today.md**
- Clear completed items; move yesterday's detail to the journal
- Keep only carryover that's still live; leave it minimal for morning prep

**workspace.md**
- Each active project / open thread = one line: status + a pointer (`entities/projects/x.md` or "search: <term>")
- If a bullet has grown into a paragraph, that detail goes to the project's entity file and the bullet becomes a pointer
- Drop resolved threads (the record is in the journal)

**human.md**
- Only genuinely new, durable facts about the user. Rare updates.

### 3b. Flags Review

Review `state/flags.md` — the channel that carries items to the user across sessions.
- For each open flag: is it still true? If addressed/merged/resolved/obsolete, remove it.
- Did today's work surface anything the user needs to see (a bug you can't fix, a decision only they can make, work awaiting their review)? Add it — **one line + a pointer** to the journal/entity with the full writeup. Do not paste the investigation into flags.md.
- Keep the list short and live. A stale flag list gets ignored.

### 4. Entity Updates

Review `entities/people/` and `entities/projects/`:
- Integrate any facts extracted by distillation
- Project status changes?
- New projects to create files for?

### 5. Compact State to Budget

State files must stay within budget. Check them:
```bash
wc -c ~/.config/macrodata/state/*.md
```
Rough targets: today ≲ 3 KB, workspace ≲ 3 KB, human ≲ 3.5 KB, flags ≲ 3 KB, identity ≲ 3 KB. (Hard cap is 4 KB each — content over that is truncated at injection.)

For any file over budget, compact it — this is expected maintenance, not optional:
- Move the detail to the journal (`log_journal`) or the relevant entity file **first**, so nothing is lost
- Then cut the state entry down to a one-line pointer, or remove it if it's resolved
- Also clear: completed todos still listed active, context no longer relevant, info duplicated across files

A file that only ever grows is the bug this step exists to catch. After compacting, re-run `wc -c` to confirm you're under budget.

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
