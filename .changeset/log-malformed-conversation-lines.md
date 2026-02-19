---
"@macrodata/opencode": patch
---

Log malformed lines in conversation parsing instead of silently skipping them. Corrupted index state now warns on reset. Makes it possible to diagnose why a session isn't appearing in search results.
