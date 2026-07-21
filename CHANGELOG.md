# Changelog

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
