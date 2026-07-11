---
"@macrodata/opencode": patch
---

Make OpenCode context injection prompt-cache friendly. The system prompt transform previously re-read state files on every request and included volatile sections (recent journal, schedules, pending daemon context), so any mid-session change — including the agent's own journal writes — changed the system prompt and invalidated the provider's cached prefix for the rest of the session. The memory context is now frozen per session, daemon deltas are delivered as synthetic parts on the incoming user message via the chat.message hook, and journal dates are formatted as ISO dates instead of locale-dependent strings. Also updates @opencode-ai/plugin and @opencode-ai/sdk from 1.1.x to 1.17.x.
