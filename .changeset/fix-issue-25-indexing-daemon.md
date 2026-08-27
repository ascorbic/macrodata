---
"@macrodata/opencode": patch
---

Fix two bugs that silently disabled the plugin for weeks (#25):

**Incremental conversation indexing was broken.** The `sinceMs` time filter in `queryExchanges` referenced `um.time_created`, but the filter is interpolated inside the `user_messages` CTE where only the `m` alias is in scope, so every incremental re-index threw `SQLiteError: no such column: um.time_created`. The filter now uses `m.time_created`. Query errors also propagate instead of being swallowed into an empty result, so a schema mismatch can no longer masquerade as "0 new exchanges" indefinitely.

**A hung agent child could wedge the daemon forever.** Scheduled `opencode run` / `claude --print` children are now supervised with a hard timeout (default 10 minutes, configurable via `MACRODATA_CHILD_TIMEOUT_MS`); on timeout the child's process group is killed and the daemon keeps running. The daemon also installs `unhandledRejection` / `uncaughtException` handlers that log and continue instead of dying, and writes a `.daemon.heartbeat` file every minute. The plugin's `ensureDaemonRunning` now detects a PID-alive-but-heartbeat-stale daemon and restarts it, so a wedged daemon self-heals on the next OpenCode session instead of staying dead for days.
