---
"@macrodata/opencode": minor
---

Budget the injected context and add a flags channel.

State files are now treated as a bounded working set instead of an append-only log. The SessionStart injection is byte-capped per section, so a bloated file can no longer blow the whole context past the harness limit (which was silently truncating it to a preview and dropping most of it). A new `state/flags.md` channel carries items to the user across sessions and is injected first so it always survives. The prompt-submit full re-dump that defeated prompt caching is removed — state changes now arrive as targeted deltas. `USAGE.md` and the memory-maintenance/dreamtime skills are updated to keep state bounded with explicit eviction (detail belongs in the journal and entity files, which are durable and searchable).
