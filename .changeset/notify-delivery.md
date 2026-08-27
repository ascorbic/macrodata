---
"macrodata": minor
---

Replace session/subagent reminder delivery with a deterministic `notify` mode.

- `schedule` now offers two delivery modes: `notify` (default) and `headless`. The `session` mode — claim files drained into active sessions as background subagents — is removed; stored schedules with `delivery: "session"` fire as `notify` automatically.
- `notify` runs no model: at fire time the daemon posts a macOS notification and upserts a `- [id] fired <time> — <payload>` line into `state/reminders.md` (a re-fire replaces the schedule's own line). Reminders surface in sessions via the SessionStart compose hook and a prompt-submit relay nudge; removing the line with the Edit tool clears the reminder.
- `headless` is unchanged: a detached `claude --print` on the tick.
- Schedule hardening: a schedule's identity is its `reminders/<id>.json` filename — the id in the body is ignored for job keys and deletes, and `remove_reminder` refuses any id outside `[A-Za-z0-9_-]{1,64}`, so neither path can be aimed at a file outside `reminders/`. A one-shot whose date doesn't parse (or already passed) is refused by `schedule` with `Not scheduled: …` instead of being saved and silently deleted. Editing a schedule file re-arms its job (the old job kept firing the old fields). Firing runs under a guard, so a payload that breaks the notification (a NUL byte, no text at all) logs an error instead of exiting the daemon.
- Relay hardening: the prompt-submit reminder and red-flag relays keep whole lines within a 2,500-byte budget and end with a `… N more line(s) not shown; read state/<file>` marker, so an oversized section can't overflow Claude Code's hook-output cap and erase every block with it. The `## ⏰` heading in `state/reminders.md` is no longer load-bearing: the relay and the SessionStart composer key on `- ` entry lines (a heading-only file composes nothing), and the daemon restores the heading if a hand-edit removed it.
