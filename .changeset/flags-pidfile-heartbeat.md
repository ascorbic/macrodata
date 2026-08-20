---
"macrodata": minor
---

Add red-flag surfacing channel (`state/flags.md`), atomic daemon pidfile acquisition, and heartbeat-first arbitration for scheduled skills.

**Red-flag surfacing** — scheduled runs can discover issues that never reach the user because they terminate in the model's context. `state/flags.md` is the new cross-session channel: the daemon fires a macOS notification when new 🔴 items appear, and the prompt-submit hook injects a relay instruction once per session (keyed by session_id + section hash, so every session is reminded and a changed section re-fires everywhere).

**Atomic pidfile** — the daemon's `existsSync` check followed by a plain `writeFileSync` let two daemons started in the same instant both survive the guard, double-firing every cron. The pidfile is now acquired with `writeFileSync(..., { flag: "wx" })`; on collision the holder is liveness-checked, a stale file is unlinked and the acquisition retried once.

**Heartbeat arbitration** — `dreamtime` and `memory-maintenance` now open by banking a journal heartbeat claiming the run, then re-reading to arbitrate, so if a double-fire does happen the losing twin stands down instead of both writing state.

Ported from ascorbic/macrodata PRs #30 and #37.
