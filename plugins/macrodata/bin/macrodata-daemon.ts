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
import { spawn } from "child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync } from "fs";
import { join, basename } from "path";
import { Cron } from "croner";
import { getStateRoot, getEntitiesDir, getJournalDir, getIndexDir, getRemindersDir } from "../src/config.js";
import { formatReminder, reminderFileName, buildHeadlessArgs, resolveModel, cronTooFrequent } from "../src/reminders.js";

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

// Dedicated channel for fired scheduled tasks, separate from the generic
// .pending-context state/entity stream. One file per schedule (keyed by id,
// last-fire-wins) which an active session claims exactly-once by atomic rename
// (see drain in macrodata-hook.sh). Replaces spawning a metered `claude -p`.
function getPendingRemindersDir() {
  return join(getStateRoot(), ".pending-reminders");
}

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string; // cron expression or ISO datetime
  description: string;
  payload: string;
  agent?: "opencode" | "claude"; // Which agent to trigger
  model?: string; // Optional model override (e.g., "anthropic/claude-opus-4-6")
  // How a fired job is delivered. "session" (default): queue a claim-file the
  // next active session drains as a background subagent. "headless": spawn a
  // detached `claude --print` on the tick — runs unattended, no-ops on sleep.
  delivery?: "session" | "headless";
  createdAt: string;
}

function log(message: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  appendFileSync(getLogFile(), line);
}

function logError(message: string) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ERROR: ${message}\n`;
  appendFileSync(getLogFile(), line);
}

function writePendingContext(message: string) {
  try {
    appendFileSync(getPendingContext(), message + "\n");
  } catch (err) {
    logError(`Failed to write pending context: ${String(err)}`);
  }
}

// Orphaned-claim TTL: a session that crashes between the drain's `mv` and `rm`
// leaves a `*.claimed.*` file the drain skips forever; a daemon crash mid-write
// can leave a `.tmp`. Both are swept once they're clearly stale. Real reminders
// are NOT swept on a timer — they're keyed by schedule id (one per schedule)
// and each firing overwrites the prior, so they self-bound and stay current.
const REMINDER_ORPHAN_TTL_MS = 5 * 60 * 1000;

// Queue length of one per schedule: the claim file is keyed by schedule id, so
// a new firing overwrites any prior unclaimed reminder for that schedule
// (last-fire-wins — "run maintenance 5×" coalesces to once, latest context).
// The dir therefore never grows past the number of distinct schedules.
// Write-then-rename so a draining session never reads a half-written notice;
// the hook claims the file with a single atomic rename (exactly-once across
// sessions). reminderFileName/formatReminder sanitize the untrusted id, model,
// description, and payload (see src/reminders.ts).
function writeReminderClaim(schedule: Schedule) {
  try {
    const dir = getPendingRemindersDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const name = reminderFileName(schedule.id);
    const tmp = join(dir, `.${name}.tmp`);
    const content = formatReminder(schedule, new Date().toLocaleString());
    writeFileSync(tmp, content + "\n");
    renameSync(tmp, join(dir, name));
  } catch (err) {
    logError(`Failed to write reminder for ${schedule.id}: ${String(err)}`);
  }
}

// Sweep stale orphans (claimed-but-not-removed, or half-written tmp). Real
// reminder files are left alone. Cheap; runs after each firing.
function gcReminderOrphans() {
  const dir = getPendingRemindersDir();
  if (!existsSync(dir)) return;
  const now = Date.now();
  for (const name of readdirSync(dir)) {
    const isOrphan = name.includes(".claimed.") || (name.startsWith(".") && name.endsWith(".tmp"));
    if (!isOrphan) continue;
    const path = join(dir, name);
    try {
      if (now - statSync(path).mtimeMs > REMINDER_ORPHAN_TTL_MS) unlinkSync(path);
    } catch (err) {
      logError(`Failed to GC orphan reminder ${name}: ${String(err)}`);
    }
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
  const dirs = [getDaemonDir(), getStateRoot(), getIndexDir(), entitiesDir, getJournalDir(), getRemindersDir(), getPendingRemindersDir(), join(entitiesDir, "people"), join(entitiesDir, "projects")];
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
  const remindersDir = getRemindersDir();
  const filePath = join(remindersDir, `${id}.json`);
  
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch (err) {
    logError(`Failed to delete schedule file ${id}: ${String(err)}`);
  }
}

class MacrodataLocalDaemon {
  private cronJobs: Map<string, Cron> = new Map();
  private watcher: ReturnType<typeof watch> | null = null;
  private schedulesWatcher: ReturnType<typeof watch> | null = null;
  private shouldRun = true;

  async start() {
    log("Starting macrodata local daemon");
    log(`State root: ${getStateRoot()}`);

    // Check if already running
    ensureDirectories();
    const pidFile = getPidFile();
    if (existsSync(pidFile)) {
      const existingPid = readFileSync(pidFile, "utf-8").trim();
      try {
        process.kill(parseInt(existingPid, 10), 0); // Check if process exists
        log(`Daemon already running (PID ${existingPid}), exiting`);
        process.exit(0);
      } catch {
        // Process doesn't exist, stale PID file - continue startup
        log(`Removing stale PID file (was ${existingPid})`);
      }
    }

    // Write PID file
    writeFileSync(pidFile, process.pid.toString());

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
        writePendingContext(`<macrodata-update type="schedule-added" id="${schedule.id}">${schedule.description}</macrodata-update>`);
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
        writePendingContext(`<macrodata-update type="schedule-updated" id="${schedule.id}">${schedule.description}</macrodata-update>`);
      } catch {}
    });

    this.schedulesWatcher.on("unlink", (path) => {
      if (!path.endsWith(".json")) return;
      const id = basename(path, ".json");
      log(`Reminder removed: ${id}`);
      writePendingContext(`<macrodata-update type="schedule-removed" id="${id}" />`);
      const job = this.cronJobs.get(id);
      if (job) {
        job.stop();
        this.cronJobs.delete(id);
        log(`Stopped job: ${id}`);
      }
    });
  }

  private reloadSchedules() {
    const schedules = loadAllSchedules();
    const now = Date.now();
    const currentIds = new Set(this.cronJobs.keys());

    for (const schedule of schedules) {
      // Skip if already running
      if (currentIds.has(schedule.id)) {
        currentIds.delete(schedule.id);
        continue;
      }

      if (schedule.type === "cron") {
        this.startCronJob(schedule);
      } else if (schedule.type === "once") {
        const fireTime = new Date(schedule.expression).getTime();
        if (fireTime > now) {
          this.startOnceJob(schedule);
        } else {
          log(`Skipping expired one-shot: ${schedule.id}`);
          this.removeSchedule(schedule.id);
        }
      }
    }

    // Stop jobs that were removed
    const scheduleIds = new Set(schedules.map(s => s.id));
    for (const id of currentIds) {
      if (!scheduleIds.has(id)) {
        const job = this.cronJobs.get(id);
        if (job) {
          job.stop();
          this.cronJobs.delete(id);
          log(`Stopped removed job: ${id}`);
        }
      }
    }
  }

  private loadAndStartSchedules() {
    const schedules = loadAllSchedules();
    const now = Date.now();

    for (const schedule of schedules) {
      if (schedule.type === "cron") {
        this.startCronJob(schedule);
      } else if (schedule.type === "once") {
        const fireTime = new Date(schedule.expression).getTime();
        if (fireTime > now) {
          this.startOnceJob(schedule);
        } else {
          log(`Skipping expired one-shot: ${schedule.id}`);
          // Remove expired one-shots
          this.removeSchedule(schedule.id);
        }
      }
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
      const job = new Cron(schedule.expression, () => {
        void this.fireSchedule(schedule);
      });
      this.cronJobs.set(schedule.id, job);
      log(`Started cron job: ${schedule.id} (${schedule.expression})`);
    } catch (err) {
      logError(`Failed to start cron job ${schedule.id}: ${String(err)}`);
    }
  }

  private startOnceJob(schedule: Schedule) {
    try {
      const fireTime = new Date(schedule.expression);
      const job = new Cron(fireTime, () => {
        void this.fireSchedule(schedule);
        // Remove one-shot after firing
        this.removeSchedule(schedule.id);
      });
      this.cronJobs.set(schedule.id, job);
      log(`Scheduled one-shot: ${schedule.id} at ${schedule.expression}`);
    } catch (err) {
      log(`Failed to schedule one-shot ${schedule.id}: ${String(err)}`);
    }
  }

  private fireSchedule(schedule: Schedule) {
    log(`Firing schedule: ${schedule.id} - ${schedule.description}`);

    if (schedule.delivery === "headless") {
      // Run on the tick, unattended (re-added pre-0.3.0 path).
      spawnHeadless(schedule);
      return;
    }

    // Default "session": queue a claim-file (one per schedule, last-fire-wins);
    // the next active session claims it and runs the task as a background subagent.
    writeReminderClaim(schedule);
    gcReminderOrphans();
    log(`Queued reminder for: ${schedule.id} (.pending-reminders)`);
  }

  addSchedule(schedule: Schedule) {
    // Save to individual file
    saveSchedule(schedule);

    // Start the job
    if (schedule.type === "cron") {
      this.startCronJob(schedule);
    } else {
      this.startOnceJob(schedule);
    }
  }

  removeSchedule(id: string) {
    // Stop the job
    const job = this.cronJobs.get(id);
    if (job) {
      job.stop();
      this.cronJobs.delete(id);
    }

    // Delete the file
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

      // State files (working memory) - inject full content
      if (path.startsWith(stateDir)) {
        try {
          const content = readFileSync(path, "utf-8");
          const filename = basename(path);
          writePendingContext(`<macrodata-update type="state" file="${filename}">\n${content}\n</macrodata-update>`);
        } catch {}
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
    for (const [_id, job] of this.cronJobs) {
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
    for (const [_id, job] of this.cronJobs) {
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
