# Changelog

## 0.9.0

### Minor Changes

- [#64](https://github.com/jasikpark/macrodata/pull/64) [`3d2e7e9`](https://github.com/jasikpark/macrodata/commit/3d2e7e95f6de744e291736faa4f3de6b05af9f83) Thanks [@jasikpark](https://github.com/jasikpark)! - Add red-flag surfacing channel (`state/flags.md`), atomic daemon pidfile acquisition, and heartbeat-first arbitration for scheduled skills.

  **Red-flag surfacing** — scheduled runs can discover issues that never reach the user because they terminate in the model's context. `state/flags.md` is the new cross-session channel: the daemon fires a macOS notification when new 🔴 items appear, and the prompt-submit hook injects a relay instruction once per session (keyed by session_id + section hash, so every session is reminded and a changed section re-fires everywhere).

  **Atomic pidfile** — the daemon's `existsSync` check followed by a plain `writeFileSync` let two daemons started in the same instant both survive the guard, double-firing every cron. The pidfile is now acquired with `writeFileSync(..., { flag: "wx" })`; on collision the holder is liveness-checked, a stale file is unlinked and the acquisition retried once.

  **Heartbeat arbitration** — `dreamtime` and `memory-maintenance` now open by banking a journal heartbeat claiming the run, then re-reading to arbitrate, so if a double-fire does happen the losing twin stands down instead of both writing state.

  Ported from ascorbic/macrodata PRs [#30](https://github.com/jasikpark/macrodata/issues/30) and [#37](https://github.com/jasikpark/macrodata/issues/37).

- [#65](https://github.com/jasikpark/macrodata/pull/65) [`bbfad4b`](https://github.com/jasikpark/macrodata/commit/bbfad4b6e291eac06d428aec86b8faae2c77b401) Thanks [@jasikpark](https://github.com/jasikpark)! - Replace session/subagent reminder delivery with a deterministic `notify` mode.

  - `schedule` now offers two delivery modes: `notify` (default) and `headless`. The `session` mode — claim files drained into active sessions as background subagents — is removed; stored schedules with `delivery: "session"` fire as `notify` automatically.
  - `notify` runs no model: at fire time the daemon posts a macOS notification and upserts a `- [id] fired <time> — <payload>` line into `state/reminders.md` (a re-fire replaces the schedule's own line). Reminders surface in sessions via the SessionStart compose hook and a prompt-submit relay nudge; removing the line with the Edit tool clears the reminder.
  - `headless` is unchanged: a detached `claude --print` on the tick.
  - Schedule hardening: a schedule's identity is its `reminders/<id>.json` filename — the id in the body is ignored for job keys and deletes, and `remove_reminder` refuses any id outside `[A-Za-z0-9_-]{1,64}`, so neither path can be aimed at a file outside `reminders/`. A one-shot whose date doesn't parse (or already passed) is refused by `schedule` with `Not scheduled: …` instead of being saved and silently deleted. Editing a schedule file re-arms its job (the old job kept firing the old fields). Firing runs under a guard, so a payload that breaks the notification (a NUL byte, no text at all) logs an error instead of exiting the daemon.
  - Relay hardening: the prompt-submit reminder and red-flag relays keep whole lines within a 2,500-byte budget and end with a `… N more line(s) not shown; read state/<file>` marker, so an oversized section can't overflow Claude Code's hook-output cap and erase every block with it. The `## ⏰` heading in `state/reminders.md` is no longer load-bearing: the relay and the SessionStart composer key on `- ` entry lines (a heading-only file composes nothing), and the daemon restores the heading if a hand-edit removed it.

### Patch Changes

- [#62](https://github.com/jasikpark/macrodata/pull/62) [`13f8e25`](https://github.com/jasikpark/macrodata/commit/13f8e251594b89787ffdf7106a4d1b456e6220b1) Thanks [@jasikpark](https://github.com/jasikpark)! - Manage the ambient-recall worker from `macrodata-hook.sh`, on both hook events, so a
  plugin update takes effect without waiting for a new session. The worker had its own
  SessionStart-only supervisor, and SessionStart does not fire on `/plugin update` +
  `/reload-plugins` — so the pass that reaps the previous version's worker only ran once
  a session happened to open, and until then a freshly installed release kept serving
  recall from the old cached code. The daemon already converged on every prompt; the
  worker now does too, through the same verified-kill path. Per-prompt passes stay silent
  unless they act, so neither the model's context nor the log gets a line per message.

  Converging on every prompt also means concurrent sessions can observe the same
  worker-less window and spawn into it together, so the worker now claims
  `.recall/worker.pid` before it can load a model and stands down if another process
  already serves that state root. A claim whose process is gone is taken over rather
  than obeyed — the hook stops a stale-version worker with SIGKILL, which never gets to
  clean up after itself. A reboot restarts the PID space from the bottom, where a
  surviving claim can name an unrelated live process and mute recall for good, so the
  hook reads the holder's own command line and clears the claim unless that process is
  itself a worker.

## 0.8.1

### Patch Changes

- [#60](https://github.com/jasikpark/macrodata/pull/60) [`2e9f122`](https://github.com/jasikpark/macrodata/commit/2e9f1229e063388d71e830171b399f9740f7668f) Thanks [@jasikpark](https://github.com/jasikpark)! - Roll the ambient-recall worker on plugin upgrade. The supervisor identified its
  workers by state root alone, so a new version adopted the previous version's
  running worker and logged it as healthy — an installed release could serve recall
  from code it does not contain, with no visible symptom. It now classifies each
  worker by the source path in its argv: this version's stays up, another plugin
  version's is reaped (SIGTERM escalating to SIGKILL, then verified) and respawned,
  and a hand-started dev worker keeps running but is announced instead of passed
  over in silence.

## 0.8.0

### Minor Changes

- [#58](https://github.com/jasikpark/macrodata/pull/58) [`833d5eb`](https://github.com/jasikpark/macrodata/commit/833d5eb86276e8fc72e2837698b62da543c817f8) Thanks [@jasikpark](https://github.com/jasikpark)! - Ship ambient recall as part of the plugin instead of a sidecar checkout.

  The retrieval pipeline (Qwen3-Embedding-0.6B / 1024-dim via node-llama-cpp) moves
  into `src/recall/`, its entry points into `bin/recall-{hook,supervisor,reindex,search}`,
  and its hooks are registered in `plugin.json` — so a marketplace install gets ambient
  recall with no manual `settings.json` wiring.

  Runtime state now resolves through the shared `getStateRoot()` and lives under
  `<root>/.recall/` (index, per-session mailbox, calibration, access log, worker logs).
  Previously it was written next to the source, which only worked for a fixed checkout
  path: plugins install into a per-version cache dir, so a source-relative index would
  be orphaned on every release. The leading dot keeps it inside the state root's
  existing "dotfiles are runtime, plain dirs are memory content" ignore rule.

  This also corrects the data root for anyone who is not the original author — the
  sidecar hardcoded `~/Documents/macrodata` rather than honoring `MACRODATA_ROOT` and
  `~/.config/macrodata/config.json`.

  Ambient recall keeps its own index: it embeds at 1024 dimensions while the MCP server
  uses MiniLM at 384, so the two cannot share a Vectra store.

  Upgrading from a hand-wired sidecar: kill any worker started by the old supervisor once
  (`pkill -f recall/worker.ts`) and drop the recall entries from `settings.json`. The new
  supervisor identifies its workers by an argv sentinel rather than by script path — which
  is what lets it reap the previous plugin version's worker on every future update — so a
  worker predating this change is invisible to it and would keep draining the same mailbox
  alongside the new one.

## 0.7.6

### Patch Changes

- [#50](https://github.com/jasikpark/macrodata/pull/50) [`d971886`](https://github.com/jasikpark/macrodata/commit/d97188670ea5b6ce32ce3743a4a67f6055a66563) Thanks [@jasikpark](https://github.com/jasikpark)! - spike(ambient-recall): fix the worker never seeing a request. Bun's `fs.watch(dir)` on macOS does not deliver an event under the final name of a `tmp` → `rename` publish, and both hook request-writes publish that way (`atomicWrite`), so the worker's filename-matched watch callback never fired for a real request — since the spike's first commit. Recall worked anyway because `ingest()`'s own `unlinkSync` _is_ a final-name event, which re-entered the callback and picked up whatever had arrived meanwhile: a self-sustaining chain that lasted only while requests arrived faster than the ~5s rerank, and left the session permanently deaf after the first lull. The watch now ignores the reported filename and re-scans the directory (50ms debounce) on any event, with a 5s interval backstop for a dropped or coalesced FSEvents batch, and drops requests older than `MACRODATA_RECALL_MAX_REQ_AGE_MS` (default 10 min) for one log line instead of a rerank whose inbox nobody will drain.

## 0.7.5

### Patch Changes

- [#47](https://github.com/jasikpark/macrodata/pull/47) [`3c1790f`](https://github.com/jasikpark/macrodata/commit/3c1790f267eb964f969092458078896d99e73a2a) Thanks [@jasikpark](https://github.com/jasikpark)! - spike(ambient-recall): structured worker logging via LogTape. The worker now emits NDJSON records with per-line timestamps under subsystem categories (`recall.worker` / `recall.ingest` / `recall.pipeline`), and the previously-silent paths are visible: a pipeline-start line (a never-settling pipeline is now provable from the log instead of inferable from absence), a warning when the short-search guard drops an already-consumed request, and a queued-behind-active-drain line that surfaces the drain-wedge failure mode in real time.

- [#49](https://github.com/jasikpark/macrodata/pull/49) [`e175304`](https://github.com/jasikpark/macrodata/commit/e1753047c9f45eb707314b5e8f456b78fe4811f4) Thanks [@jasikpark](https://github.com/jasikpark)! - Structured logging via LogTape across the plugin proper. Library modules (`indexer`, `conversations`, `embeddings`, `rerank`) now log NDJSON records under per-module `macrodata.*` categories, routed by whichever entrypoint configured a sink: the MCP server sends diagnostics to stderr, and the daemon appends them to `.daemon.log` (which also captures indexer/conversations records that previously vanished into the daemon's discarded stdout). Fixes a protocol bug: `manage_index` rebuild/update completions were `console.log`ged onto the MCP server's stdout, which is the JSON-RPC channel. In unconfigured processes (hook scripts, tests) records drop silently, so model-load and index chatter can no longer leak into hook output.

## 0.7.4

### Patch Changes

- [#45](https://github.com/jasikpark/macrodata/pull/45) [`1cb3935`](https://github.com/jasikpark/macrodata/commit/1cb3935c4cc53a20e35714d98af7388803869bee) Thanks [@jasikpark](https://github.com/jasikpark)! - Widen ambient recall legs from 20 to 40 candidates per leg and add MMR diversification to the rerank-pool selection. The two changes are one mechanism: wider legs raise the density of near-duplicates in the fused slate (adjacent journal days restating the same fact, an entity section and the journal entry that seeded it), and MMR is the counterweight that keeps the fixed 20-slot rerank pool from filling with restatements of its own top hit. Selection is greedy over `λ·relevance − (1−λ)·maxSim(candidate, picked)` with λ=0.55, matching Porrima's passive-recall composition: a single pre-rerank MMR pass over recency-adjusted scores, with relevance min-max normalized within the slate so the λ blend isn't dead against raw RRF magnitudes (~1/60).

  Similarity is true vector cosine, not token overlap: the FTS corpus is built from the same vectra `listItems()` pass that carries every candidate's embedding, so a content→vector map covers both legs for free, and paraphrase redundancy — the same fact reworded, invisible to Jaccard — is what actually pollutes the pool. Jaccard over tokens remains only as a degraded fallback for candidates missing a vector. Widening is free at query time (vectra scores every item regardless; the FTS leg scans the full corpus), and the cross-encoder still sees exactly 20 candidates, so rerank latency — the pipeline's real bottleneck — is unchanged. New knobs: `MACRODATA_RECALL_LEG_K` (default 40) and `MACRODATA_RECALL_MMR_LAMBDA` (default 0.55; ≥1 degenerates to plain top-k).

  Removed: the ambient index's topic-exclusion feature (`MACRODATA_RECALL_TOPIC_EXCLUDE` and its hardcoded `/calibration/i` catch-all). Journal parsing now indexes every topic. The catch-all matched the substring anywhere in any topic name, so real content topics (`self-calibration`, `review-calibration`) were silently dropped; the env var could widen the exclusion but never narrow it below the regex; and because orphan pruning reconciles the index to the scan, a topic that started matching had its already-indexed vectors retroactively deleted on the next rebuild. Consequence: recall-telemetry topics (`ambient-memory-*calibration`) re-enter the ambient index at the next rebuild — keeping telemetry out of ambient recall needs a different mechanism than index-time exclusion.

## 0.7.3

### Patch Changes

- [#44](https://github.com/jasikpark/macrodata/pull/44) [`62bc6c9`](https://github.com/jasikpark/macrodata/commit/62bc6c953c072127b327cd609334ad888bc105d4) Thanks [@jasikpark](https://github.com/jasikpark)! - Prune vectors whose source items no longer exist, and add `reindex.ts --prune-only` to run that reconcile without re-embedding. The ambient index only ever upserted, so a vector outlived the journal line, section, or file it came from and kept scoring against live material forever — nothing deleted, so the index drifted upward indefinitely. Measured before the fix: 2783 vectors against 2762 real items, and every one of the 21 orphans was a section of a single deleted entity file that kept surfacing at 0.99. That file is the ghost behind a recall misdiagnosis where a superseded entity outranked the correction written to replace it.

  Reconciling is cheap in a way rebuilding is not — scanning is file reads, while embedding is the entire cost of a rebuild — so `--prune-only` finishes in about 4 seconds where a full rebuild takes about 13 minutes. An empty scan is refused rather than honored: an unreadable or misconfigured data root produces one far more often than a genuinely empty corpus does, and reconciling against it would delete every vector, recoverable only by re-embedding the whole corpus.

- [#41](https://github.com/jasikpark/macrodata/pull/41) [`21f6fa8`](https://github.com/jasikpark/macrodata/commit/21f6fa87afc0ed75d15465e0e2f59d4015179b75) Thanks [@jasikpark](https://github.com/jasikpark)! - Ask each session which memory files earned their place, and give `/dreamtime` a step that acts on the answers. `save_conversation_summary` gains `unhelpfulFiles` and `helpfulFiles`, and the SessionEnd and PreCompact hook prompts request them. Nothing else in the system can produce this signal: relevance scores rank a superseded file and its own correction identically, so a stale entity keeps outranking the file that fixed it, every session, forever — only a session that actually used both can say which one did the work. `unhelpfulFiles` is asked first and demands paths, because self-assessment runs optimistic and "which files helped?" invites generous partial credit for anything that was merely on topic.

  A new "Memory File ROI" step in `/dreamtime` reads those lines back out of the last ~20 `conversation-summary` entries and treats a path named unhelpful 3+ times as worth a look — correcting or merging in place, after reading the file against its live siblings, since the common cause is a superseded file competing with its own correction rather than a file that deserves removal. The step explicitly does not remove anything: the run is unattended, so a wrong call goes uncaught, and writing a file empty leaves an indexed husk that still outranks its replacement. Removal candidates get journaled with their evidence for an interactive session to act on.

## 0.7.2

### Patch Changes

- [#39](https://github.com/jasikpark/macrodata/pull/39) [`80b208b`](https://github.com/jasikpark/macrodata/commit/80b208b81ff4efc4f6d5611d5bafb0bc21fb6c42) Thanks [@jasikpark](https://github.com/jasikpark)! - Install the plugin's dependencies on SessionStart instead of leaning on bun's auto-install. Marketplace installs copy the plugin into a per-version cache dir but never run an install, and Claude Code's dependency auto-install does not fire for `bun.lock` ([anthropics/claude-code#47634](https://github.com/anthropics/claude-code/issues/47634)), so the MCP server, the daemon, and every `bin/*.ts` script resolved their imports out of bun's global auto-install cache. That cache cannot host native modules: the sharp binary loads `@rpath/libvips-cpp.<ver>.dylib` relative to a sibling `node_modules` layout the versioned cache dir names do not provide, and phantom deps (`@huggingface/transformers` bare-imports `onnxruntime-common`) are simply absent. `search_memory` broke this way twice. The new `bin/ensure-deps.sh` hook installs into the persistent per-plugin data dir (`${CLAUDE_PLUGIN_DATA}`, which survives plugin updates and is removed on uninstall, per the [plugins reference](https://code.claude.com/docs/en/plugins-reference#persistent-data-directory)) and symlinks it in as the plugin root's `node_modules`, so every entry point resolves dependencies the ordinary way with no `NODE_PATH` plumbing. Two independent idempotent guards keep it cheap and self-healing: it reinstalls only when the shipped `package.json` or `bun.lock` differs from the copy stored alongside the install, and it re-points the symlink on every run, which is what heals the fresh version dir a plugin update leaves behind when dependencies did not change. A failed install removes the stored manifests so the next session retries rather than treating the failure as up to date, the happy path prints nothing (SessionStart stdout is injected into the model's context), and an unset `CLAUDE_PLUGIN_DATA` (opencode, older clients) exits silently and changes nothing. A real `node_modules` directory in the plugin root, such as a dev checkout's own install, is never touched.

## 0.7.1

### Patch Changes

- [#37](https://github.com/jasikpark/macrodata/pull/37) [`37bb7f2`](https://github.com/jasikpark/macrodata/commit/37bb7f2b8d243b25e1e633916b3457115dda052e) Thanks [@jasikpark](https://github.com/jasikpark)! - Make `/distill`'s transcript extraction actually runnable in scheduled (headless) sessions. The previous step invoked `jq -rn -f bin/transcript-text.jq` into a `mktemp -d` dir inside a `for` loop, with an `rm -rf` cleanup — and with nobody present to answer permission prompts, Claude Code's command-approval layer refuses every one of those: `-f` trips a dangerous-flags heuristic (independent of workspace trust), and `mktemp`/`mkdir`, compound commands, and `rm` all require an approval no unattended run can give. (This is the permission layer, not sandbox mode — under `sandbox.enabled` these commands run, but sandboxing currently breaks Go-based network tools like `gh`, see anthropics/claude-code#26466, so the skill does not assume it.) Each nightly run therefore fell back to improvising its own parser and littering the memory root — the exact failure the extraction step was added to prevent. The skill now instructs the proven-permitted shape, verified against a live headless run: one single-command `jq -r` per transcript with the filter program inline, redirected as a flat file into the existing gitignored `.scratch/` directory, no cleanup step (leftovers are inert there; interactive maintenance may tidy). `bin/transcript-text.jq` is removed rather than kept as a second copy — nothing can load it at runtime (unattended runs can neither pass `-f` nor read the plugin dir), so the skill is the filter's single source of truth.

## 0.7.0

### Minor Changes

- [#32](https://github.com/jasikpark/macrodata/pull/32) [`c7d4767`](https://github.com/jasikpark/macrodata/commit/c7d4767318406262cbc524f84c56ce42b90b230b) Thanks [@jasikpark](https://github.com/jasikpark)! - Ambient memory recall (beta, opt-in): on UserPromptSubmit / PostToolUse / Stop, a hook asks a local retrieval pipeline for memories relevant to the current context and injects hits on the next opportunity via a file-mailbox protocol. Dual-leg retrieval (Vectra vector + FTS) with RRF fusion, last-accessed recency bias, and Qwen3 cross-encoder rerank — running fully in-process on Metal via node-llama-cpp 3.19.1 (one background worker, no llama-server processes). Off by default: lives under `spike/ambient-recall-nlc/` and runs only where the hooks are wired via `.claude/settings.local.json`. `MACRODATA_RECALL_MODE` picks async (default — models live only in the worker) vs sync (inline, debug-only). Soak + a backtest harness gate the reification into the installed plugin.

### Patch Changes

- [#35](https://github.com/jasikpark/macrodata/pull/35) [`a7475ec`](https://github.com/jasikpark/macrodata/commit/a7475ec597c00fc18af467f607c8cbb18acd1ed7) Thanks [@jasikpark](https://github.com/jasikpark)! - Give `/distill` a canonical transcript-extraction step instead of asking each sub-agent to "filter to conversation content" on its own. A new bundled filter, `bin/transcript-text.jq`, deterministically converts a raw Claude Code transcript to human + assistant text only — dropping tool calls, tool results, thinking blocks, and harness plumbing (slash-command echoes, `<usage>` telemetry) — and shrinks a transcript ~44x (18MB → ~420KB on a real session). The distill coordinator now pre-extracts each transcript to a `mktemp -d` temp dir and points sub-agents at the clean text. This kills the failure mode where every scheduled run hand-rolled a throwaway JSONL parser and littered the memory root with scratch files.

- [#33](https://github.com/jasikpark/macrodata/pull/33) [`ee1119b`](https://github.com/jasikpark/macrodata/commit/ee1119b77de7754c103d27b3bb9d9022eddf2afb) Thanks [@jasikpark](https://github.com/jasikpark)! - Migrate from `@xenova/transformers` to `@huggingface/transformers` (replicates ascorbic/macrodata#35). Modern sharp (0.34) ships prebuilt binaries with no postinstall script, so bun's blocked-lifecycle-script behavior can no longer break the native binary install — including in consumers that install the plugin through a generated wrapper package (Claude Code / OpenCode plugin cache), where `trustedDependencies` from this repo does not apply. Same model, same 384-dim embeddings; existing indexes stay valid. The daemon also lazy-loads the indexing modules so its PID file appears in a few hundred ms instead of several seconds.

## 0.6.0

### Minor Changes

- [#30](https://github.com/jasikpark/macrodata/pull/30) [`d54da2b`](https://github.com/jasikpark/macrodata/commit/d54da2bbf466e0d40b088ff6d7a6c77934c76b0f) Thanks [@jasikpark](https://github.com/jasikpark)! - Add the `five-whys` skill: structured root-cause analysis that forces behavioral resolutions into verifiable artifacts. Instead of stopping at "I'll remember to X," it drives each bedrock cause to a concrete diff — a `state/identity.md` rule, a scheduled job, a hook change, or a journal/entity edit. Invoke when a pattern keeps recurring, behavior has drifted, or a fix is about to become a resolution to "try harder." Adapted from the five-whys skill in [open-strix](https://github.com/tkellogg/open-strix) (Tim Kellogg, MIT); methodology unchanged, storage and action surfaces rewritten for macrodata's own tools.

### Patch Changes

- [#28](https://github.com/jasikpark/macrodata/pull/28) [`166ef83`](https://github.com/jasikpark/macrodata/commit/166ef83fae331b9483209defaff02d14e33f717d) Thanks [@jasikpark](https://github.com/jasikpark)! - Log malformed lines in journal and conversation parsing instead of silently skipping them. The journal indexer (`parseJournalForIndexing`) and the conversation parser (`parseConversationFile`, `expandConversation`) now count unparseable lines and `console.warn`, so corrupted or multi-line entries that drop out of search are diagnosable instead of vanishing silently. Unreadable journal files warn too.

- [#31](https://github.com/jasikpark/macrodata/pull/31) [`3afd9ed`](https://github.com/jasikpark/macrodata/commit/3afd9ed8ccd540af53c27258c2eef7ddc6111405) Thanks [@jasikpark](https://github.com/jasikpark)! - Rebalance the `schedule` tool's `delivery` description so `session` and `headless` read as two first-class, intent-based choices (session = a human should see/act on it; headless = it should just run on its own), rather than framing `headless` as a "reserve for trusted background jobs" last resort. Keeps the honest caveats — headless runs unsupervised and no-ops while the machine is asleep (e.g. a laptop on battery) — but as constraints to design around, not reasons to avoid it.

## 0.5.1

### Patch Changes

- [#25](https://github.com/jasikpark/macrodata/pull/25) [`4cb8e04`](https://github.com/jasikpark/macrodata/commit/4cb8e0422cf51b73ac28c2fac760ae9c68f6fc12) Thanks [@jasikpark](https://github.com/jasikpark)! - Generate the changelog at the repo root. The root is now a workspace member (`workspaces: ["."]`) with a name + version, so changesets versions the **root** package and `changeset version` writes `CHANGELOG.md` at the repo root natively (the [#1137](https://github.com/changesets/changesets/issues/1137) workaround); the nested `@macrodata/opencode` plugin package is changeset-`ignore`d. `scripts/version.ts` syncs the bumped root version into the plugin's package.json and both Claude Code plugin manifests. Removes the stale pre-fork upstream `plugins/macrodata/CHANGELOG.md`.

- [#21](https://github.com/jasikpark/macrodata/pull/21) [`c7864f1`](https://github.com/jasikpark/macrodata/commit/c7864f1b514358366dae47c797c68f9e9efeffde) Thanks [@jasikpark](https://github.com/jasikpark)! - context-doctor: clarify that the daemon auto-reindexes entity add/change incrementally (`indexEntityFile`, ~1s debounce), so a manual `manage_index` rebuild is only needed after **deletes or renames** — and for those the fix is `rm -rf <root>/.index` + rebuild, since rebuild is upsert-only and won't purge orphaned records. ([#20](https://github.com/jasikpark/macrodata/issues/20))

- [#21](https://github.com/jasikpark/macrodata/pull/21) [`c7864f1`](https://github.com/jasikpark/macrodata/commit/c7864f1b514358366dae47c797c68f9e9efeffde) Thanks [@jasikpark](https://github.com/jasikpark)! - Re-add changesets-driven release automation (versioning only, no npm publish). `bun run version` runs `changeset version` and syncs the bumped version into `plugin.json` + `marketplace.json`; `changeset tag` creates the `vX.Y.Z` git tag. The release workflow uses the default `GITHUB_TOKEN` (no GitHub App) and never publishes to npm — the package is now `private`, and the plugin installs via the Claude Code marketplace. Replaces the manual 3-file version bump.

## [0.5.0] — 2026-06-16

### Added

- **Per-schedule `delivery` mode (`session` | `headless`)** (#18). `session` (default) queues a reminder drained into your next interactive session as a background subagent — the unchanged 0.3.0 behavior. `headless` spawns a detached `claude --print` on the cron tick, running the job unattended on schedule (the pre-0.3.0 path, claude-only). The headless model is clamped to a safe alias, and the payload is passed behind a `--` end-of-options sentinel so it can't be parsed as a CLI flag.

### Changed

- **Cron schedules must fire at least 2 minutes apart.** Sub-2-minute cadences are rejected — both when a schedule is created (the `schedule` tool) and when the daemon loads it at startup — bounding the headless spawn rate. macrodata has no sub-2-minute use case; an existing sub-2m schedule is refused with a logged error. (Normal-cadence schedules are unaffected, including hand-edited ones — only the cadence is checked, not how the schedule got there.)

## [0.4.0] — 2026-06-15

### Added

- **`context-doctor` skill** — on-demand diagnosis and repair of memory degradation: state-file bloat against the display cap, stale or overlapping entity descriptions, redundancy, and index-coverage gaps. Distinct from the scheduled `memory-maintenance` skill. (#16)

### Fixed

- **All entity categories are now indexed for `search_memory`, not just `people` and `projects`.** The indexer hardcoded those two types, so `topics/`, `agents/`, and `learnings/` were silently absent from semantic search — roughly half the entity store. The `entities/` folder list is now the single source of truth: `rebuildIndex` and `indexEntityFile` derive the item type from the folder name, and the `search_memory` `type` filter is built from the live folders, so new categories index automatically. (#15)

### Changed

- **Search-filter values changed:** `search_memory`'s `type` filter now uses the entity folder name verbatim — `people`/`projects` (previously `person`/`project`), plus any other category folder. **After upgrading, run `rm -rf <root>/.index` then `manage_index` rebuild once** to backfill previously-unindexed entities and drop the old singular-typed records. (#15)
- `manage_index` rebuild is documented as upsert-only — it re-scans and updates but does not purge records for deleted or renamed files. (#15)
- Onboarding now scaffolds `entities/topics/` instead of a stray top-level `topics/`; removed the unused `getTopicsDir()` helper. (#15)

### Removed

- Unused upstream changesets release machinery (`.changeset/`, `release.yml`, `scripts/version.ts`, and the `@changesets/*` root devDeps). Releases are manual; the process is documented in `CLAUDE.md`.

## [0.3.1] — 2026-06-15

### Changed

- Reattributed the fork to jasikpark (#11): author/owner and repository/homepage/bugs URLs now point at `jasikpark/macrodata`, the README install command and logo target the fork, and a `LICENSE` file was added (none existed) carrying both copyright lines — Matt Kane (original) and Caleb Jasik — plus a fork note. Matt Kane is preserved as a `package.json` contributor; the upstream `Thanks @ascorbic` changelog history is untouched.

### Fixed

- **A stale daemon kept running old code after a plugin upgrade (#12).** The PID file is version-agnostic (keyed to the state root), but the daemon runs from a version-specific cache path — so after an upgrade `start_daemon` saw the old daemon's live PID and skipped restarting it, and crons kept firing on the previous version's code. `start_daemon` now pins the live PID once and classifies it by its `ps` argv against its own versioned `$DAEMON`: same version → leave it; a different `/plugins/cache/` version → SIGTERM (escalating to SIGKILL if ignored), clear the pidfile, respawn from the new path; a daemon running from outside the cache (a hand-started dev checkout) → left alone. `signal_daemon_reload` gained the same argv guard so a recycled PID can't be SIGHUP'd. Hook-only; the MCP server is session-scoped and still needs a session reload after upgrade.

### Notes

- Bundles two changes that landed on `main` after `v0.3.0` without their own bump (#11 attribution, #13 daemon fix), and brings this changelog current (the `0.2.7` and `0.3.0` entries below were backfilled in the same release).
- The daemon-restart fix is hook-delivered, so it applies immediately on the upgrade that ships it: Claude Code runs the freshly-installed version's hook, which restarts a still-running older-version daemon on the next session-start/prompt-submit. (Verified on the `0.3.0` → `0.3.1` upgrade — the running `0.3.0` daemon was auto-replaced, no manual kill.)
- Hardened across a 3-round adversarial review (5 → 3 → 0 findings; SIGKILL escalation, pinned-PID TOCTOU close, reload guard, wedge test).
- Plugin version bumped `0.3.0` → `0.3.1` in `marketplace.json`, `plugin.json`, and `package.json`.

## [0.3.0] — 2026-06-14

### Changed

- **Scheduled tasks now inject reminders into the active session instead of spawning a metered `claude --print` (#10).** A cron fire previously launched a headless `claude --print` per run — measured at ~$811/mo at API rates, ~4× the credit pool. Now a firing writes one claim-file per schedule (keyed by id, last-fire-wins) into `.pending-reminders/`; a dedicated `inject_reminders` prompt-submit hook drains it, claiming each file by atomic rename so concurrent sessions can't double-grab a run, and the reminder asks the session to run the task as a background subagent with the schedule's model pinned. The now-dead `triggerAgent` spawn path was removed.
  - New `src/reminders.ts` (pure, property-tested) sanitizes the untrusted schedule `id` (path-traversal-safe filename), `payload`/`description` (can't break the `<macrodata-scheduled-task>` frame), and `model` (mapped to an alias allowlist so an injected schedule can't re-pin an expensive model). Zod constraints added at the `schedule` MCP-tool boundary.
- Tests: `reminders-sanitize.test.ts` (`fast-check` property fuzzing of every sanitizer) plus concurrent-claim and hostile-input cases in `hook.test.ts`.

### Notes

- Tradeoff: subagents draw from the active session's window rather than time-shifting load to off-hours as `claude --print` did — accepted for this first burn-killing version.
- Hardened across a 2-round adversarial review (2 critical + 1 major fixed: path traversal, verbatim/newline injection, model re-pin).
- Plugin version bumped `0.2.7` → `0.3.0`.

## [0.2.7] — 2026-06-11

### Fixed

- **The schedule model override was ignored on `claude --print` fires (#8).** The `claude` branch of `triggerAgent` never forwarded `options.model` (only the opencode branch did), so every cron inherited the user's default model — e.g. a `sync-prs` schedule pinned to haiku had been running on opus/fable. Now `--model` is passed when the schedule has one, stripping the opencode-style `anthropic/` prefix (schedules store `anthropic/claude-sonnet-4-6`; `claude` expects the bare id/alias).

### Notes

- Plugin version bumped `0.2.6` → `0.2.7`.

## [0.2.6] — 2026-05-29

### Changed

- **SessionStart state is now sharded into per-file hooks.** Each state file is injected by its own hook so it gets its own ~10,000-char hook-output envelope (anthropics/claude-code#44086 caps each hook output string independently and runs SessionStart hooks in parallel), instead of all sections fighting inside one envelope and cliff-truncating to a 2K preview.
  - New `plugins/macrodata/bin/compose-state-file.ts` (reusable): `bun compose-state-file.ts today.md` → reads `state/<file>`, head-keeps to that file's cap (**chars _and_ lines, whichever first**), neutralizes `</macrodata*` tag-openers, wraps in `<macrodata-<tag>>`, and emits a display-only truncation marker (pointing at the intact file + nudging distill / `[[wikilink]]`-out / journal-relocate, never delete) when clipped. Per-file caps live in a `BUDGETS` table; default **9,000 chars / 150 lines** (start-high, tune-down — the char cap binds at launch, the line cap starts dormant as a concision lever). Registered 4× in `plugin.json` (identity/today/human/workspace).
  - New `plugins/macrodata/bin/compose-lists.ts`: journal + schedules in one hook, carrying the progressive-disclosure bounding (per-entry `zod` validation, first-line cap, footer pointers), a touch more generous (7 entries / 500-char first-lines — set from real data: journal first-lines average ~377 chars, so the prior 220 truncated ~64% of entries mid-sentence).
  - `plugins/macrodata/bin/macrodata-hook.sh` `session-start` no longer composes context — it now only manages the daemon (`start_daemon`/`signal_daemon_reload`) and emits the first-run `/onboarding` nudge when unconfigured. `inject_static_context`, the bash journal/schedules helpers, and the `prompt-submit` `check_files_changed` re-injection are removed (mid-session state changes are the daemon `.pending-context` channel's job).
- Tests: `compose-state-file.test.ts` and `compose-lists.test.ts` (inline snapshots + `fast-check` property tests — caps/whichever-first, neutralization, missing-file, malformed-entry skip, bounding); `hook.test.ts` rewritten to the new contract (session-start emits nothing when configured; first-run nudge; no prompt-submit re-injection); and `sessionstart-integration.test.ts` — a full-output snapshot that builds a complete mock store and runs every SessionStart hook in `plugin.json` registration order (also fails if a hook is removed/reordered/renamed or starts emitting unexpected content).
- Injection hardening (from an adversarial review): all schedule fields (`type`/`expression`, not just `description`) are tag-neutralized so a hostile reminder `expression` can't forge a sibling block; the first-run `<macrodata-detected-user>` JSON is tag-neutralized so a hostile git/GECOS name can't break the wrapper; surrogate-pair-split slices drop a trailing lone high surrogate (no `U+FFFD` mojibake) in both composers; and `compose-state-file.ts` hard-bounds its final output so a degenerate sub-marker-length cap can't exceed the budget.

### Notes

- Supersedes the closed PR #2 (single budget-aware composer): a per-file head-keep hook is simpler than a multi-section allocator and gives each state file independent tuning. The dynamic-state cliff (was ~48K → 2K preview) is resolved by sharding; caps are pragmatic soft-ish defaults to tune empirically, not derived constants.
- Plugin version bumped from `0.2.5` to `0.2.6` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the sharded SessionStart hooks on `/plugin upgrade`.

## [0.2.5] — 2026-05-28

### Added

- Dedicated `SessionStart` hook for the **files manifest**: `plugins/macrodata/bin/compose-files.ts` (TypeScript) + thin wrapper `plugins/macrodata/bin/inject-files.sh`, registered as a third no-matcher `SessionStart` entry in `plugin.json`. Renders a Letta-MemFS-style "filetree-as-index": one line per state/entity file, `- <path> — <description>` when an **entity** carries an authored frontmatter `description:`, else a bare `- <path>`, plus a single aggregate footer counting the entities still lacking one (a nudge to add it). Descriptions are read **only** from authored frontmatter — never scraped from the body/heading (a scraped heading just echoes the filename). **State files (`state/*.md`) are exempt** — they're always injected in full by the dynamic-state composer, so the manifest lists them as plain pointers and never nudges for a description; descriptions earn their keep only on entities, whose bodies are not injected. Runs in its own ~10K hook-output envelope so the index never competes with the composer's budget. Tag-openers in descriptions are entity-escaped (injection hardening); a defensive head-keep guards against a pathological store exceeding the cap.
- `USAGE.md` documents the `description:` frontmatter convention in the Entities section (what it's for, that it feeds the manifest, that missing ones are nudged, and that state files are exempt) — written as "describe what the file _is_, not its status" so descriptions don't drift.
- The memory skills now teach the `description:` convention so newly-created/updated entities carry one: `onboarding` (+ OpenCode variant) shows an entity-file template with `description:` frontmatter; `distill`, `memory-maintenance`, and `dreamtime` (+ OpenCode variants) instruct adding/preserving it, and `memory-maintenance` backfills missing ones. Examples use synthetic stand-ins, not real personal data.
- The `onboarding` state-file templates (identity/today/human/workspace, + OpenCode variant) now ship with a `description:` frontmatter cribbed from `USAGE.md`'s explanation of each file. State files stay **manifest-exempt** (the listing still shows them as bare pointers), but because they're injected in full, the description rides along inline as a per-file purpose reminder — mirroring Letta's `block.description`.
- Tests at `plugins/macrodata/test/compose-files.test.ts`: inline snapshots for the rendering cases (state-file exemption, inline descriptions, no-scrape, footer presence/absence, description cap) and `fast-check` property tests (arbitrary descriptions stay under the 10K cliff with exactly one intact closer; footer count always equals the number of undescribed entities).

### Changed

- `plugins/macrodata/bin/macrodata-hook.sh` no longer emits `<macrodata-files>` from its monolithic `inject_static_context` heredoc (the `list_state_files` helper is removed); the files manifest now comes solely from the dedicated hook above, so it is never double-injected and is no longer truncated inside the big state blob.
- Plugin version bumped from `0.2.4` to `0.2.5` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the files manifest + the skills convention on `/plugin upgrade`.

## [0.2.4] — 2026-05-28

### Added

- Dedicated `SessionStart` hook `plugins/macrodata/bin/inject-usage.sh` that injects `USAGE.md` in full. Registered as a second (no-matcher) `SessionStart` entry in `plugin.json`, so the ~4.7K guide lands in its own ~10,000-char hook-output envelope (anthropics/claude-code#44086 caps each hook output string independently; multiple SessionStart hooks run in parallel) instead of competing for budget inside the main state blob. No-matcher means it fires on `startup`/`resume`/`clear`/`compact` — and re-firing on `compact` is what keeps the guide present after compaction.

### Changed

- `plugins/macrodata/bin/macrodata-hook.sh` no longer emits `<macrodata-usage>` from its monolithic `inject_static_context` heredoc (the `get_usage` helper is removed); USAGE.md now comes solely from the dedicated hook above, so it is never double-injected.
- Plugin version bumped from `0.2.3` to `0.2.4` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the new hook on `/plugin upgrade`.

### Misc

- `.gitignore`: ignore the local `.gest/` task store.

## [0.2.3] — 2026-05-22

### Added

- New `/remember` skill at `plugins/macrodata/skills/remember/SKILL.md`. Thin trigger that maps "save the conversation" / `/remember` to `save_conversation_summary`. Intentionally minimal — no prescription of what the summary looks like; the tool's schema and session context handle the rest.

### Changed

- Plugin version bumped from `0.2.2` to `0.2.3` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the new skill on `/plugin upgrade`.

## [0.2.2] — 2026-05-22

### Added

- New `UserPromptSubmit` hook `bin/suggest-memory-tools.sh`: emits a static `<macrodata-tools-hint>` block nudging the model to call `mcp__plugin_macrodata_macrodata__search_memory`, `mcp__plugin_macrodata_macrodata__get_recent_journal`, or `mcp__plugin_qmd_qmd__query` when recall is actually needed. Cost: one shell exec per prompt, no bun startup, no index reads.
- `systemMessage` on the new hook so you can see `[macrodata] injected reminder about search_memory + qmd recall tools` per turn (the `additionalContext` block alone is only visible to the model).

### Changed

- Plugin version bumped from `0.2.1` to `0.2.2` in `marketplace.json`, `plugin.json`, and `package.json` so the marketplace picks up the new release on `/plugin upgrade`.

### Deprecated

- `bin/ambient-memory.ts` and `bin/ambient-memory-qmd.ts` are no longer registered in `plugin.json`. Both files remain in-tree with `DEPRECATED 2026-05-22 — DELETE ME` headers explaining the burn-in verdict (operationally-useful surfacings on <10% of turns at 2–28s/prompt latency). Slated for deletion if nothing reaches for them within a couple months.

### Notes

- This version exists because two prior `feat(ambient)` commits — one adding the parallel qmd hook for A/B comparison, one retiring both hooks — landed on `main` without a version bump. The marketplace tracks by version, not git SHA, so consumers couldn't see either change until this release rolled them up.

## [0.2.1] — 2026-05-21

### Added

- Cross-encoder reranking layer over the bi-encoder search, with `MACRODATA_AMBIENT_RERANK=1` toggle and `MACRODATA_AMBIENT_DUAL=1` to surface a vector-only eval block alongside the reranked one. `MACRODATA_AMBIENT_CANDIDATE_K=40` widens the slate handed to the cross-encoder so title-less section chunks have a better shot at landing in it.

[Unreleased]: https://github.com/jasikpark/macrodata/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/jasikpark/macrodata/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/jasikpark/macrodata/compare/v0.2.7...v0.3.0
[0.2.7]: https://github.com/jasikpark/macrodata/compare/v0.2.6...v0.2.7
[0.2.6]: https://github.com/jasikpark/macrodata/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/jasikpark/macrodata/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/jasikpark/macrodata/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/jasikpark/macrodata/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/jasikpark/macrodata/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/jasikpark/macrodata/releases/tag/v0.2.1
