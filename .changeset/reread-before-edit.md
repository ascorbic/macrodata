---
"@macrodata/opencode": patch
---

Add reminder to re-read files immediately before editing in background skills. Claude Code's read tracking requires a recent read before each edit, and long background sessions can accumulate enough context between initial read and eventual edit to cause the check to fail silently.
