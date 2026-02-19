---
"@macrodata/opencode": patch
---

Fix daemon inheriting CLAUDECODE from Claude Code session, causing all scheduled `claude --print` invocations to fail with "nested session" error.
