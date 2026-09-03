---
"macrodata": patch
---

Throttle the tools-hint hook to fire every 11 turns instead of every turn.

The hint nudges the model to call recall tools intentionally, but injecting it on
every single prompt adds context noise for minimal benefit — the model doesn't need
the reminder on turn 2 if it saw it on turn 1. A per-session counter file in /tmp
(keyed on `CLAUDE_CODE_SESSION_ID`) tracks invocations and suppresses output on
non-interval turns; the first turn of each session always fires.
