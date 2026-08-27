#!/usr/bin/env bun
/**
 * Macrodata Local Daemon
 *
 * Handles scheduled tasks, file watching for index updates, and triggers
 * Claude Code or OpenCode via CLI when reminders fire.
 *
 * Usage:
 *   MACRODATA_ROOT=~/.config/macrodata bun run macrodata-daemon.ts
 *
 * Environment:
 *   MACRODATA_AGENT=opencode|claude  (default: auto-detect)
 *   MACRODATA_ROOT=/path/to/state
 */

import { watch } from "chokidar";
import { execSync, spawn } from "child_process";
import { configure, getLogger, jsonLinesFormatter } from "@logtape/logtape";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync, renameSync } from "fs";
import { join, basename } from "path";
import { Cron } from "croner";
import { getStateRoot, getEntitiesDir, getJournalDir, getIndexDir, getRemindersDir } from "../src/config.js";
import { formatReminderEntry, upsertReminderLine, buildHeadlessArgs, resolveModel, resolveDelivery, cronTooFrequent, isSafeId, notificationText } from "../src/reminders.js";

// The indexing modules pull in @huggingface/transformers + vectra (multi-second
// import). Load them lazily so the daemon writes its PID file and starts
// scheduling immediately instead of blocking on heavy imports.
async function loadIndexer() {
  return import("../src/indexer.js");
}

async function loadConversationIndexers() {
  const [oc, cc] = await Promise.all([
    import("../opencode/conversations.js"),
    import("../src/conversations.js"),
  ]);
  return {
    updateOpenCodeConversations: oc.updateConversationIndex,
    updateClaudeCodeConversations: cc.updateConversationIndex,
  };
}

function parseRedFlags(markdown: string): string[] {
  const flags: string[] = [];
  let inRed = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      inRed = line.startsWith("## 🔴");
      continue;
    }
    if (inRed && line.startsWith("- ")) {
      const name = line.match(/\*\*(.+?)\*\*/)?.[1] ?? line.slice(2);
      flags.push(name.trim());
    }
  }
  return flags.filter(Boolean);
}

// Daemon-specific path helpers
// Use MACRODATA_ROOT for all daemon files (PID, log) to support testing with isolated directories
function getDaemonDir() {
  return getStateRoot();
}

function getPidFile() {
  return join(getDaemonDir(), ".daemon.pid");
}

function getLogFile() {
  return join(getDaemonDir(), ".daemon.log");
}

function getPendingContext() {
  return join(getStateRoot(), ".pending-context");
}

// Fired notify-reminders land in a state file, so they ride the existing
// state-file rails: compose-state-file.ts injects them at SessionStart, the
// file watcher's .pending-context update surfaces a fresh fire mid-session,
// and inject_reminder_relay (macrodata-hook.sh) nudges the model to relay and
// clear them.
function getRemindersStateFile() {
  return join(getStateRoot(), "state", "reminders.md");
}

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string; // cron expression or ISO datetime
  description: string;
  payload: string;
  agent?: "opencode" | "claude"; // Which agent to trigger
  model?: string; // Optional model override (e.g., "anthropic/claude-opus-4-6")
  // How a fired job is delivered. "notify" (default): upsert an entry into
  // state/reminders.md + post a macOS notification — no model runs. "headless":
  // spawn a detached `claude --print` on the tick — runs unattended, no-ops on
  // sleep. "session" is a legacy stored value that fires as "notify".
  delivery?: "notify" | "headless" | "session";
  createdAt: string;
}

// NDJSON to .daemon.log, one appendFileSync per record (atomic under
// O_APPEND, matching how this file has always been written). Routing the
// whole macrodata.* tree here also captures the lazily-imported indexer/
// conversations modules, whose diagnostics previously went to the daemon's
// detached (and discarded) stdout. getLogFile() is resolved per record so a
// MACRODATA_ROOT change is honored without reconfiguring.
await configure({
  sinks: {
    file: (record) => appendFileSync(getLogFile(), jsonLinesFormatter(record)),
  },
  loggers: [
    { category: ["macrodata"], lowestLevel: "debug", sinks: ["file"] },
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["file"] },
  ],
});
const daemonLog = getLogger(["macrodata", "daemon"]);

// LogTape parses {…} in a message string as template placeholders (unmatched
// ones render as "undefined"), and callers here pass pre-built strings that
// can embed JSON — so escape braces ({{ is LogTape's literal {) instead of
// letting payload text hit the template parser.
function asLiteral(message: string): string {
  return message.replaceAll("{", "{{").replaceAll("}", "}}");
}

function log(message: string) {
  daemonLog.info(asLiteral(message));
}

function logError(message: string) {
  daemonLog.error(asLiteral(message));
}

function writePendingContext(message: string) {
  try {
    appendFileSync(getPendingContext(), message + "\n");
  } catch (err) {
    logError(`Failed to write pending context: ${String(err)}`);
  }
}

// One entry line per schedule, keyed by sanitized id: a re-fired reminder
// that was never addressed updates its own line in place (last-fire-wins)
// instead of stacking, so the file stays bounded by the number of distinct
// notify schedules. Write-then-rename so the file watcher and a concurrent
// session read never see a half-written file. The session removes a line with
// the Edit tool once the reminder is addressed; formatReminderEntry sanitizes
// the untrusted id and payload (see src/reminders.ts).
function upsertReminderEntry(schedule: Schedule) {
  try {
    const file = getRemindersStateFile();
    const existing = existsSync(file) ? readFileSync(file, "utf-8") : null;
    const entry = formatReminderEntry(schedule, new Date());
    const next = upsertReminderLine(existing, entry, schedule.id);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, file);
  } catch (err) {
    logError(`Failed to write reminder entry for ${schedule.id}: ${String(err)}`);
  }
}

// Post a macOS notification, fire-and-forget. The body goes through
// notificationText (osascript string literal + spawn's no-NUL rule) and the
// call is guarded: it runs inside cron callbacks, where a thrown exception
// takes the daemon down.
function notifyUser(text: unknown, title: string) {
  try {
    const proc = spawn("osascript", ["-e", `display notification "${notificationText(text)}" with title "${title}"`], {
      stdio: "ignore",
      detached: true,
    });
    proc.on("error", (err) => logError(`osascript notification failed: ${String(err)}`));
    proc.unref();
  } catch (err) {
    logError(`osascript notification failed: ${String(err)}`);
  }
}

// delivery: "headless" — spawn a detached `claude --print` on the tick, the
// pre-0.3.0 behavior (claude-only; the old opencode branch was dropped). Runs
// unattended on schedule without a live session — the pre-0.3.0 behavior that
// ran dreamtime reliably for months. (A host genuinely asleep at fire time
// would miss that tick, but in practice that's been rare.) Each fire spawns
// with NO last-fire-wins coalescing (unlike the session claim-file), so keep
// headless to jobs that finish well within their cadence — a sub-runtime
// cadence (e.g. */5 on a slow task) could overlap itself. The model is clamped
// to a safe alias by buildHeadlessArgs → resolveModel. Fire-and-forget: detached
// + unref so the daemon never waits on it.
function spawnHeadless(schedule: Schedule) {
  try {
    const proc = spawn("claude", buildHeadlessArgs(schedule), {
      cwd: getStateRoot(),
      stdio: "ignore",
      detached: true,
    });
    proc.on("error", (err) => logError(`Headless spawn failed for ${schedule.id}: ${String(err)}`));
    // Fail loudly: a nonzero exit is an ERROR, not a same-level "exited" line, so
    // a failed run doesn't read like a successful one. No silent fallback —
    // surface it and move on.
    proc.on("exit", (code) =>
      code === 0
        ? log(`Headless ${schedule.id} completed`)
        : logError(`Headless ${schedule.id} exited with code ${code}`)
    );
    proc.unref();
    log(`Spawned headless claude --print for ${schedule.id} (model ${resolveModel(schedule.model)})`);
  } catch (err) {
    logError(`Failed to spawn headless for ${schedule.id}: ${String(err)}`);
  }
}

function ensureDirectories() {
  const entitiesDir = getEntitiesDir();
  const dirs = [getDaemonDir(), getStateRoot(), getIndexDir(), entitiesDir, getJournalDir(), getRemindersDir(), join(entitiesDir, "people"), join(entitiesDir, "projects")];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log(`Created directory: ${dir}`);
    }
  }
}

async function updateAllConversationIndexes() {
  const { updateClaudeCodeConversations, updateOpenCodeConversations } = await loadConversationIndexers();

  // Update Claude Code conversations
  try {
    const claude = await updateClaudeCodeConversations();
    if (claude.filesUpdated > 0) {
      log(`Claude Code conversations: +${claude.filesUpdated} files (${claude.exchangeCount} total)`);
    }
  } catch (err) {
    logError(`Claude Code conversation index failed: ${String(err)}`);
  }

  // Update OpenCode conversations
  try {
    const opencode = await updateOpenCodeConversations();
    if (opencode.newCount > 0) {
      log(`OpenCode conversations: +${opencode.newCount} (${opencode.totalCount} total)`);
    }
  } catch (err) {
    logError(`OpenCode conversation index failed: ${String(err)}`);
  }
}

function loadAllSchedules(): Schedule[] {
  const remindersDir = getRemindersDir();
  const schedules: Schedule[] = [];

  try {
    if (!existsSync(remindersDir)) return schedules;
    
    const files = readdirSync(remindersDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = readFileSync(join(remindersDir, file), "utf-8");
        const schedule = JSON.parse(content) as Schedule;
        // The filename is the schedule's identity. Job keys, the reminders.md
        // line, and every delete path derive from it, so a body id such as
        // "../../.claude/settings" can never name a file outside reminders/.
        const id = basename(file, ".json");
        if (schedule.id !== id) {
          logError(`Schedule ${file} declares id ${JSON.stringify(schedule.id)}; keying it by filename instead`);
        }
        schedule.id = id;
        schedules.push(schedule);
      } catch (err) {
        logError(`Failed to load schedule ${file}: ${String(err)}`);
      }
    }
  } catch (err) {
    logError(`Failed to read reminders directory: ${String(err)}`);
  }

  return schedules;
}

function saveSchedule(schedule: Schedule) {
  const remindersDir = getRemindersDir();
  const filePath = join(remindersDir, `${schedule.id}.json`);
  
  try {
    writeFileSync(filePath, JSON.stringify(schedule, null, 2));
  } catch (err) {
    logError(`Failed to save schedule ${schedule.id}: ${String(err)}`);
  }
}

function deleteScheduleFile(id: string) {
  // Ids are filename stems (loadAllSchedules) or came through the MCP tool's
  // SAFE_ID_RE check; anything else is refused rather than joined into a path.
  if (!isSafeId(id)) {
    logError(`Refusing to delete schedule with unsafe id ${JSON.stringify(id)}`);
    return;
  }
  const filePath = join(getRemindersDir(), `${id}.json`);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err) {
    logError(`Failed to delete schedule file ${id}: ${String(err)}`);
  }
}

// A running job plus the on-disk content it was armed from. The Cron callback
// closed over that content, so a reload compares fingerprints to tell an
// edited schedule (stop and re-arm) from an unchanged one (leave running).
interface ArmedJob {
  job: Cron;
  fingerprint: string;
}

function fingerprintOf(schedule: Schedule): string {
  return JSON.stringify(schedule);
}

class MacrodataLocalDaemon {
  private cronJobs: Map<string, ArmedJob> = new Map();
  private watcher: ReturnType<typeof watch> | null = null;
  private schedulesWatcher: ReturnType<typeof watch> | null = null;
  private shouldRun = true;

  private acquirePidFile(pidFile: string): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(pidFile, process.pid.toString(), { flag: "wx" });
        return true;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          logError(`PID file creation failed: ${String(err)}`);
          return false;
        }
        let existingPid = "";
        try {
          existingPid = readFileSync(pidFile, "utf-8").trim();
          const pid = parseInt(existingPid, 10);
          process.kill(pid, 0);
          let cmd = "";
          try {
            cmd = execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" }).trim();
          } catch {}
          if (cmd.includes("macrodata-daemon")) {
            log(`Daemon already running (PID ${existingPid}), exiting`);
            return false;
          }
          log(`PID ${existingPid} alive but not a macrodata daemon (${cmd || "unknown"}), reclaiming`);
        } catch {
          log(`Removing stale PID file (was ${existingPid || "empty"})`);
        }
        try {
          unlinkSync(pidFile);
        } catch (e) {
          logError(`Failed to remove stale PID file: ${String(e)}`);
        }
      }
    }
    log("Could not acquire PID file after retry, exiting");
    return false;
  }

  async start() {
    log("Starting macrodata local daemon");
    log(`State root: ${getStateRoot()}`);

    ensureDirectories();
    const pidFile = getPidFile();
    if (!this.acquirePidFile(pidFile)) {
      process.exit(0);
    }

    // Set up signal handlers
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
    process.on("SIGHUP", () => this.reload());

    // Preload embedding model and update conversation indexes in background
    loadIndexer()
      .then((indexer) => indexer.preloadModel())
      .then(() => {
        log("Embedding model preloaded");
        // After model is loaded, incrementally update both conversation indexes
        return updateAllConversationIndexes();
      })
      .catch((err) => logError(`Failed to preload/index: ${err}`));

    // Load and start schedules
    this.loadAndStartSchedules();

    // Watch for schedule changes
    this.watchRemindersDir();

    // Start file watcher for entity changes
    this.startFileWatcher();

    // Keep process alive
    log("Daemon running");
  }

  private watchRemindersDir() {
    const remindersDir = getRemindersDir();
    log(`Watching for reminders in: ${remindersDir}`);

    this.schedulesWatcher = watch(remindersDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100 },
    });

    this.schedulesWatcher.on("add", (path) => {
      if (!path.endsWith(".json")) return;
      log(`Reminder added: ${basename(path)}`);
      this.reloadSchedules();
      try {
        const schedule = JSON.parse(readFileSync(path, "utf-8")) as Schedule;
        writePendingContext(`<macrodata-update type="schedule-added" id="${basename(path, ".json")}">${schedule.description}</macrodata-update>`);
      } catch {}
    });

    this.schedulesWatcher.on("error", (err) => {
      logError(`Reminders watcher error: ${String(err)}`);
    });

    this.schedulesWatcher.on("change", (path) => {
      if (!path.endsWith(".json")) return;
      log(`Reminder changed: ${basename(path)}`);
      this.reloadSchedules();
      try {
        const schedule = JSON.parse(readFileSync(path, "utf-8")) as Schedule;
        writePendingContext(`<macrodata-update type="schedule-updated" id="${basename(path, ".json")}">${schedule.description}</macrodata-update>`);
      } catch {}
    });

    this.schedulesWatcher.on("unlink", (path) => {
      if (!path.endsWith(".json")) return;
      const id = basename(path, ".json");
      log(`Reminder removed: ${id}`);
      writePendingContext(`<macrodata-update type="schedule-removed" id="${id}" />`);
      if (this.stopJob(id)) log(`Stopped job: ${id}`);
    });
  }

  // Arm one loaded schedule. A one-shot with an unparseable date is refused and
  // left on disk (a hand-edit typo is no reason to lose the file); one whose
  // time has passed is removed, since nothing is left for it to do.
  private armSchedule(schedule: Schedule) {
    if (schedule.type === "cron") {
      this.startCronJob(schedule);
      return;
    }
    if (schedule.type !== "once") {
      logError(`Refusing schedule ${schedule.id}: unknown type ${JSON.stringify(schedule.type)}`);
      return;
    }
    const fireTime = new Date(schedule.expression).getTime();
    if (Number.isNaN(fireTime)) {
      logError(`Refusing one-shot ${schedule.id}: "${schedule.expression}" is not a valid date`);
      return;
    }
    if (fireTime <= Date.now()) {
      log(`Skipping expired one-shot: ${schedule.id}`);
      this.removeSchedule(schedule.id);
      return;
    }
    this.startOnceJob(schedule);
  }

  private stopJob(id: string): boolean {
    const armed = this.cronJobs.get(id);
    if (!armed) return false;
    armed.job.stop();
    this.cronJobs.delete(id);
    return true;
  }

  private reloadSchedules() {
    const schedules = loadAllSchedules();
    const onDisk = new Set<string>();

    for (const schedule of schedules) {
      onDisk.add(schedule.id);
      const armed = this.cronJobs.get(schedule.id);
      if (armed) {
        if (armed.fingerprint === fingerprintOf(schedule)) continue;
        // Edited on disk: the running job closed over the old fields.
        this.stopJob(schedule.id);
        log(`Reminder edited, re-arming: ${schedule.id}`);
      }
      this.armSchedule(schedule);
    }

    for (const id of [...this.cronJobs.keys()]) {
      if (!onDisk.has(id)) {
        this.stopJob(id);
        log(`Stopped removed job: ${id}`);
      }
    }
  }

  private loadAndStartSchedules() {
    for (const schedule of loadAllSchedules()) {
      this.armSchedule(schedule);
    }
  }

  private startCronJob(schedule: Schedule) {
    // Enforce the ≥2-minute floor for hand-edited / pre-existing JSON that
    // never went through the schedule tool's validation. A hot headless cron
    // would otherwise spawn unbounded (no coalescing).
    if (cronTooFrequent(schedule.expression)) {
      logError(`Refusing too-frequent cron ${schedule.id} (${schedule.expression}): must be at least 2 minutes apart`);
      return;
    }
    try {
      const job = new Cron(schedule.expression, () => this.fireSchedule(schedule));
      this.cronJobs.set(schedule.id, { job, fingerprint: fingerprintOf(schedule) });
      log(`Started cron job: ${schedule.id} (${schedule.expression})`);
    } catch (err) {
      logError(`Failed to start cron job ${schedule.id}: ${String(err)}`);
    }
  }

  private startOnceJob(schedule: Schedule) {
    try {
      const fireTime = new Date(schedule.expression);
      const job = new Cron(fireTime, () => {
        this.fireSchedule(schedule);
        // Remove one-shot after firing
        this.removeSchedule(schedule.id);
      });
      this.cronJobs.set(schedule.id, { job, fingerprint: fingerprintOf(schedule) });
      log(`Scheduled one-shot: ${schedule.id} at ${schedule.expression}`);
    } catch (err) {
      log(`Failed to schedule one-shot ${schedule.id}: ${String(err)}`);
    }
  }

  // Runs inside a croner callback, where an escaping exception is uncaught and
  // exits the process — so no single schedule's contents may get that far.
  private fireSchedule(schedule: Schedule) {
    try {
      log(`Firing schedule: ${schedule.id} - ${schedule.description}`);

      if (resolveDelivery(schedule.delivery) === "headless") {
        // Run on the tick, unattended.
        spawnHeadless(schedule);
        return;
      }

      // "notify": two deterministic actions, no model — upsert the reminder into
      // state/reminders.md (surfaced in sessions by compose-state-file.ts +
      // inject_reminder_relay) and nudge the human directly via macOS
      // notification, so the reminder lands even with no session open.
      if (schedule.delivery === "session") {
        log(`Schedule ${schedule.id} has legacy delivery "session" — firing as "notify"`);
      }
      upsertReminderEntry(schedule);
      notifyUser(schedule.description || schedule.payload, "Macrodata ⏰");
      log(`Reminder noted for: ${schedule.id} (state/reminders.md + notification)`);
    } catch (err) {
      logError(`Firing ${schedule.id} failed: ${String(err)}`);
    }
  }

  addSchedule(schedule: Schedule) {
    saveSchedule(schedule);
    this.armSchedule(schedule);
  }

  removeSchedule(id: string) {
    this.stopJob(id);
    deleteScheduleFile(id);

    log(`Removed schedule: ${id}`);
  }

  private startFileWatcher() {
    const stateRoot = getStateRoot();
    const entitiesDir = getEntitiesDir();
    const stateDir = join(stateRoot, "state");

    // Watch both state files and entities
    this.watcher = watch([stateDir, entitiesDir], {
      ignoreInitial: true,
      persistent: true,
    });

    this.watcher.on("all", (event, path) => {
      if (!path.endsWith(".md")) return;
      if (event !== "add" && event !== "change") return;

      log(`File ${event}: ${path}`);

      // State files (working memory) - inject content, capped so a mid-session
      // delta can't blow the context budget (mirrors the session-start cap).
      if (path.startsWith(stateDir)) {
        try {
          const raw = readFileSync(path, "utf-8");
          const cap = 4000;
          let sliced = raw.length > cap ? raw.slice(0, cap) : raw;
          const last = sliced.charCodeAt(sliced.length - 1);
          if (last >= 0xd800 && last <= 0xdbff) sliced = sliced.slice(0, -1);
          const content =
            raw.length > cap
              ? `${sliced}\n[…truncated: ${cap} of ${raw.length} chars. This file is over budget — compact it.]`
              : sliced;
          const filename = basename(path);
          writePendingContext(`<macrodata-update type="state" file="${filename}">\n${content}\n</macrodata-update>`);
        } catch {}
        if (basename(path) === "flags.md") {
          this.debouncedNotifyRedFlags(path);
        }
      }
      // Entity files - inject just the name
      else if (path.startsWith(entitiesDir)) {
        const relative = path.slice(entitiesDir.length + 1);
        // Ignore dot-dir artifacts (.obsidian, .trash, .git) at any depth.
        // NOTE: filter on the entities-relative path, NOT the absolute path —
        // the default store lives under ~/.config/macrodata, so an absolute
        // dotfile match would ignore the entire store.
        if (relative.split("/").slice(0, -1).some((seg) => seg.startsWith("."))) return;
        writePendingContext(`<macrodata-update type="entity" file="${relative}" />`);
        this.queueReindex(path);
      }
    });

    log(`Watching for state/entity changes in: ${stateRoot}`);
  }

  private redFlagTimer: ReturnType<typeof setTimeout> | null = null;

  private debouncedNotifyRedFlags(flagsPath: string) {
    if (this.redFlagTimer) clearTimeout(this.redFlagTimer);
    this.redFlagTimer = setTimeout(() => this.notifyNewRedFlags(flagsPath), 200);
  }

  private notifyNewRedFlags(flagsPath: string) {
    try {
      const seenFile = join(getDaemonDir(), ".flags-notified");
      const current = parseRedFlags(readFileSync(flagsPath, "utf-8"));
      const seen = new Set(
        existsSync(seenFile) ? readFileSync(seenFile, "utf-8").split("\n").filter(Boolean) : [],
      );
      const fresh = current.filter((f) => !seen.has(f));
      writeFileSync(seenFile, current.join("\n"));
      if (fresh.length === 0) return;
      const detail = fresh.length === 1 ? fresh[0] : `${fresh[0]} (+${fresh.length - 1} more)`;
      notifyUser(detail, "Macrodata 🔴");
    } catch (err) {
      logError(`Red flag notification failed: ${String(err)}`);
    }
  }

  private reindexQueue: Set<string> = new Set();
  private reindexTimer: ReturnType<typeof setTimeout> | null = null;

  private queueReindex(path: string) {
    this.reindexQueue.add(path);

    // Debounce: wait 1 second for more changes before reindexing
    if (this.reindexTimer) {
      clearTimeout(this.reindexTimer);
    }
    this.reindexTimer = setTimeout(() => {
      void this.processReindexQueue();
    }, 1000);
  }

  private async processReindexQueue() {
    if (this.reindexQueue.size === 0) return;

    const paths = Array.from(this.reindexQueue);
    this.reindexQueue.clear();

    log(`Reindexing ${paths.length} file(s)`);
    const indexer = await loadIndexer();
    for (const path of paths) {
      try {
        await indexer.indexEntityFile(path);
        log(`  ✓ ${basename(path)}`);
      } catch (err) {
        log(`  ✗ ${basename(path)}: ${String(err)}`);
      }
    }
  }

  private reload() {
    log("Reloading config (SIGHUP)");
    log(`New state root: ${getStateRoot()}`);

    // Stop existing watchers
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
    if (this.schedulesWatcher) {
      void this.schedulesWatcher.close();
      this.schedulesWatcher = null;
    }

    // Stop all cron jobs
    for (const { job } of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();

    // Ensure directories exist with new paths
    ensureDirectories();

    // Restart everything with new paths
    this.loadAndStartSchedules();
    this.watchRemindersDir();
    this.startFileWatcher();

    log("Reload complete");
  }

  private shutdown() {
    log("Shutting down");
    this.shouldRun = false;

    // Stop all cron jobs
    for (const { job } of this.cronJobs.values()) {
      job.stop();
    }
    this.cronJobs.clear();

    // Stop file watchers
    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }
    if (this.schedulesWatcher) {
      void this.schedulesWatcher.close();
      this.schedulesWatcher = null;
    }

    // Clean up PID file
    try {
      const pidFile = getPidFile();
      if (existsSync(pidFile)) {
        const pid = readFileSync(pidFile, "utf-8").trim();
        if (pid === process.pid.toString()) {
          require("fs").unlinkSync(pidFile);
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    process.exit(0);
  }
}

// Main
const daemon = new MacrodataLocalDaemon();
daemon.start().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
