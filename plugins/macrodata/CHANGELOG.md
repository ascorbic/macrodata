# @macrodata/opencode

## 0.3.1

### Patch Changes

- [#34](https://github.com/ascorbic/macrodata/pull/34) [`46d7728`](https://github.com/ascorbic/macrodata/commit/46d7728188f7ed16b456825fdd9d64b59805f1b6) Thanks [@vinayakkulkarni](https://github.com/vinayakkulkarni)! - Fix two bugs that silently disabled the plugin for weeks (#25):

  **Incremental conversation indexing was broken.** The `sinceMs` time filter in `queryExchanges` referenced `um.time_created`, but the filter is interpolated inside the `user_messages` CTE where only the `m` alias is in scope, so every incremental re-index threw `SQLiteError: no such column: um.time_created`. The filter now uses `m.time_created`. Query errors also propagate instead of being swallowed into an empty result, so a schema mismatch can no longer masquerade as "0 new exchanges" indefinitely.

  **A hung agent child could wedge the daemon forever.** Scheduled `opencode run` / `claude --print` children are now supervised with a hard timeout (default 10 minutes, configurable via `MACRODATA_CHILD_TIMEOUT_MS`, or per schedule via `timeoutMs`); on timeout the child's process group is killed and the daemon keeps running. The daemon also installs `unhandledRejection` / `uncaughtException` handlers that log and continue instead of dying, and writes a `.daemon.heartbeat` file every minute. The plugin's `ensureDaemonRunning` now detects a PID-alive-but-heartbeat-stale daemon and restarts it, so a wedged daemon self-heals on the next OpenCode session instead of staying dead for days.

- [#32](https://github.com/ascorbic/macrodata/pull/32) [`ee80b99`](https://github.com/ascorbic/macrodata/commit/ee80b99413099f94c5f9b0b14c4f6dcc3a14aadd) Thanks [@ascorbic](https://github.com/ascorbic)! - Genericize personal references in shipped content. The onboarding example dialogue and the conversation-path decoder comment used the maintainer's name and username; they now use a placeholder name and a neutral example path. Author/repository metadata is unchanged.

- [#37](https://github.com/ascorbic/macrodata/pull/37) [`6a4a42a`](https://github.com/ascorbic/macrodata/commit/6a4a42a0f1a748d675fd3ce1088ce3512dde78b9) Thanks [@ascorbic](https://github.com/ascorbic)! - Make OpenCode context injection prompt-cache friendly. The system prompt transform previously re-read state files on every request and included volatile sections (recent journal, schedules, pending daemon context), so any mid-session change — including the agent's own journal writes — changed the system prompt and invalidated the provider's cached prefix for the rest of the session. The memory context is now frozen per session, and mid-session changes reach the model as system-reminder parts on the incoming user message: daemon deltas, plus any memory context sections that changed since the session snapshot (delivered once, as full section replacements). Journal dates are formatted as ISO dates instead of locale-dependent strings. Also updates @opencode-ai/plugin and @opencode-ai/sdk from 1.1.x to 1.17.x.

## 0.3.0

### Minor Changes

- [#30](https://github.com/ascorbic/macrodata/pull/30) [`2807c49`](https://github.com/ascorbic/macrodata/commit/2807c492349f6dbcb715707ab7a68a556aac7481) Thanks [@ascorbic](https://github.com/ascorbic)! - Budget the injected context and add a flags channel.

  State files are now treated as a bounded working set instead of an append-only log. The SessionStart injection is byte-capped per section, so a bloated file can no longer blow the whole context past the harness limit (which was silently truncating it to a preview and dropping most of it). A new `state/flags.md` channel carries items to the user across sessions and is injected first so it always survives. The prompt-submit full re-dump that defeated prompt caching is removed — state changes now arrive as targeted deltas. `USAGE.md` and the memory-maintenance/dreamtime skills are updated to keep state bounded with explicit eviction (detail belongs in the journal and entity files, which are durable and searchable).

### Patch Changes

- [#17](https://github.com/ascorbic/macrodata/pull/17) [`bf421cb`](https://github.com/ascorbic/macrodata/commit/bf421cba85a095391b6e85cc7864f3de622aee28) Thanks [@jasikpark](https://github.com/jasikpark)! - Log malformed lines in conversation parsing instead of silently skipping them. Corrupted index state now warns on reset. Makes it possible to diagnose why a session isn't appearing in search results.

## 0.2.1

### Patch Changes

- [#12](https://github.com/ascorbic/macrodata/pull/12) [`a8906f5`](https://github.com/ascorbic/macrodata/commit/a8906f5c98db2c16fe0d44f29c8d9ed339909d23) Thanks [@ascorbic](https://github.com/ascorbic)! - Update distill skill for SQLite session storage format

## 0.2.0

### Minor Changes

- [#9](https://github.com/ascorbic/macrodata/pull/9) [`9c37516`](https://github.com/ascorbic/macrodata/commit/9c37516367cec8474483373ace3b529ea87410f6) Thanks [@ascorbic](https://github.com/ascorbic)! - Read OpenCode conversations from SQLite instead of file-based storage. Uses `bun:sqlite` with no new dependencies. Fixes project resolution by joining session to project worktree. Requires OpenCode v1.2.0+.

### Patch Changes

- [#10](https://github.com/ascorbic/macrodata/pull/10) [`8c4d770`](https://github.com/ascorbic/macrodata/commit/8c4d7703ee52cb3809d0c4ab132849530f003174) Thanks [@ascorbic](https://github.com/ascorbic)! - Move context injection from chat.message hook to system prompt transform. Fixes session titles all showing as "innie memory system setup" because synthetic message parts were sent to the title generation LLM.

## 0.1.3

### Patch Changes

- [#5](https://github.com/ascorbic/macrodata/pull/5) [`acb2066`](https://github.com/ascorbic/macrodata/commit/acb20667b40435839f81359aba8a0904a394b43a) Thanks [@ascorbic](https://github.com/ascorbic)! - Include USAGE.md in published package

## 0.1.2

### Patch Changes

- [`bdec5e7`](https://github.com/ascorbic/macrodata/commit/bdec5e7ab8f7e1537ff63fdcc64672a836aa63e8) Thanks [@ascorbic](https://github.com/ascorbic)! - Improve context injection and fix schedules display

  - Use XML tags for context sections (better parsing)
  - Fix schedules to read from reminders directory
  - Add shared USAGE.md with explicit guidance
  - Dynamic entity directory scanning
  - Notify pending context on state/entity file changes

## 0.1.1

### Patch Changes

- [`5973e45`](https://github.com/ascorbic/macrodata/commit/5973e45f3e4a3fcf02011e525678f71f63ce2dd0) Thanks [@ascorbic](https://github.com/ascorbic)! - Fix daemon file watcher and conversation indexing

  - Fix reminders watcher not detecting new files (watch directory instead of glob pattern)
  - Index both Claude Code and OpenCode conversations on daemon startup

- [`5dc8366`](https://github.com/ascorbic/macrodata/commit/5dc8366a6a9df8a274b0f8861151895effd30020) Thanks [@ascorbic](https://github.com/ascorbic)! - Add daemon hot-reload support and cleanup

  - Daemon now supports SIGHUP to reload config without restart
  - Daemon logs to file instead of console
  - Hook and OpenCode plugin signal daemon reload on session start
  - Context now lists actual state/entity files instead of just paths
  - Dynamic import of transformers library for faster startup
  - Remove redundant readStateFile and indexFile tools

## 0.1.0

### Minor Changes

- [`c53012e`](https://github.com/ascorbic/macrodata/commit/c53012eaaf031ccd812afc4d472754a8226f2f6c) Thanks [@ascorbic](https://github.com/ascorbic)! - Initial version
