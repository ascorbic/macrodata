---
"@macrodata/opencode": patch
---

Keep the Mac awake while a scheduled agent run is in progress. On macOS the daemon now holds a `caffeinate -is` assertion for the lifetime of each `claude --print` / `opencode run` child. Previously a run that fired while the machine was asleep (for example lid closed overnight) only advanced during brief maintenance wakes and was killed by the wall-clock timeout long before it finished. The assertion has no effect on battery with the lid closed, where macOS forces sleep regardless.
