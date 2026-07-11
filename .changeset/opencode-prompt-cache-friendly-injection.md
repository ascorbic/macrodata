---
"@macrodata/opencode": patch
---

Make OpenCode context injection prompt-cache friendly. The system prompt transform previously re-read state files on every request and included volatile sections (recent journal, schedules, pending daemon context), so any mid-session change — including the agent's own journal writes — changed the system prompt and invalidated the provider's cached prefix for the rest of the session. The memory context is now frozen per session, and mid-session changes reach the model as system-reminder parts on the incoming user message: daemon deltas, plus any memory context sections that changed since the session snapshot (delivered once, as full section replacements). Journal dates are formatted as ISO dates instead of locale-dependent strings. Also updates @opencode-ai/plugin and @opencode-ai/sdk from 1.1.x to 1.17.x.
