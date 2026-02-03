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
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { Cron } from "croner";
import { spawn } from "child_process";
import { indexEntityFile, preloadModel } from "../src/indexer.js";
import { getStateRoot, getEntitiesDir, getJournalDir, getIndexDir, getSchedulesFile } from "../src/config.js";

// Daemon-specific path helpers
const DAEMON_DIR = join(homedir(), ".config", "macrodata");

function getPidFile() {
  return join(DAEMON_DIR, ".daemon.pid");
}

function getPendingContext() {
  return join(getStateRoot(), ".pending-context");
}

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string; // cron expression or ISO datetime
  description: string;
  payload: string;
  agent?: "opencode" | "claude"; // Which agent to trigger
  model?: string; // Optional model override (e.g., "anthropic/claude-opus-4-5")
  createdAt: string;
}

/**
 * Trigger an agent with a message
 */
async function triggerAgent(
  agent: "opencode" | "claude" | undefined,
  message: string,
  options: { model?: string; description?: string } = {}
): Promise<boolean> {
  if (!agent) {
    log("No agent specified in schedule, skipping trigger");
    return false;
  }

  const timestamp = new Date().toLocaleString();
  const fullMessage = `[Scheduled reminder: ${options.description || "reminder"}]\nCurrent time: ${timestamp}\n\n${message}`;

  try {
    if (agent === "opencode") {
      // opencode run "message" --model provider/model
      const args = ["run", fullMessage];
      if (options.model) {
        args.push("--model", options.model);
      }
      
      log(`Triggering OpenCode: opencode run "..." ${options.model ? `--model ${options.model}` : ""}`);
      
      const proc = spawn("opencode", args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      proc.unref();

      // Log output for debugging
      proc.stdout?.on("data", (data) => {
        log(`[opencode stdout] ${data.toString().trim()}`);
      });
      proc.stderr?.on("data", (data) => {
        log(`[opencode stderr] ${data.toString().trim()}`);
      });

      return true;
    } else if (agent === "claude") {
      // claude --print "message" or claude -p "message"
      const args = ["--print", fullMessage];
      
      log(`Triggering Claude Code: claude --print "..."`);
      
      const proc = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      proc.unref();

      return true;
    }
  } catch (err) {
    log(`Failed to trigger ${agent}: ${String(err)}`);
  }

  return false;
}

interface ScheduleStore {
  schedules: Schedule[];
}

function log(message: string) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${message}`);
}

function writePendingContext(message: string) {
  try {
    appendFileSync(getPendingContext(), message + "\n");
  } catch (err) {
    log(`Failed to write pending context: ${String(err)}`);
  }
}

function ensureDirectories() {
  const entitiesDir = getEntitiesDir();
  const dirs = [DAEMON_DIR, getStateRoot(), getIndexDir(), entitiesDir, getJournalDir(), join(entitiesDir, "people"), join(entitiesDir, "projects")];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log(`Created directory: ${dir}`);
    }
  }
}

function loadSchedules(): ScheduleStore {
  try {
    const schedulesFile = getSchedulesFile();
    if (existsSync(schedulesFile)) {
      return JSON.parse(readFileSync(schedulesFile, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load schedules: ${String(err)}`);
  }
  return { schedules: [] };
}

function saveSchedules(store: ScheduleStore) {
  try {
    writeFileSync(getSchedulesFile(), JSON.stringify(store, null, 2));
  } catch (err) {
    log(`Failed to save schedules: ${String(err)}`);
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

    // Preload embedding model in background (don't block startup)
    preloadModel()
      .then(() => log("Embedding model preloaded"))
      .catch((err) => log(`Failed to preload embedding model: ${err}`));

    // Load and start schedules
    this.loadAndStartSchedules();

    // Watch for schedule changes
    this.watchSchedulesFile();

    // Start file watcher for entity changes
    this.startFileWatcher();

    // Keep process alive
    log("Daemon running");
  }

  private watchSchedulesFile() {
    const schedulesFile = getSchedulesFile();
    this.schedulesWatcher = watch(schedulesFile, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100 },
    });

    this.schedulesWatcher.on("change", () => {
      log("Schedules file changed, reloading...");
      this.reloadSchedules();
    });

    this.schedulesWatcher.on("add", () => {
      log("Schedules file created, loading...");
      this.reloadSchedules();
    });
  }

  private reloadSchedules() {
    const store = loadSchedules();
    const now = Date.now();
    const currentIds = new Set(this.cronJobs.keys());

    for (const schedule of store.schedules) {
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

    // Stop jobs that were removed from the file
    const storeIds = new Set(store.schedules.map(s => s.id));
    for (const id of currentIds) {
      if (!storeIds.has(id)) {
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
    const store = loadSchedules();
    const now = Date.now();

    for (const schedule of store.schedules) {
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
    try {
      const job = new Cron(schedule.expression, () => {
        void this.fireSchedule(schedule);
      });
      this.cronJobs.set(schedule.id, job);
      log(`Started cron job: ${schedule.id} (${schedule.expression})`);
    } catch (err) {
      log(`Failed to start cron job ${schedule.id}: ${String(err)}`);
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

  private async fireSchedule(schedule: Schedule) {
    log(`Firing schedule: ${schedule.id} - ${schedule.description}`);

    // Always write to pending context (for hooks to pick up)
    const message = `[macrodata] Reminder: ${schedule.description}\n${schedule.payload}`;
    writePendingContext(message);

    // Trigger the agent specified in the schedule
    const triggered = await triggerAgent(schedule.agent, schedule.payload, {
      model: schedule.model,
      description: schedule.description,
    });

    if (triggered) {
      log(`Successfully triggered ${schedule.agent} for: ${schedule.id}`);
    } else if (schedule.agent) {
      log(`Failed to trigger ${schedule.agent} for: ${schedule.id}`);
    } else {
      log(`No agent specified for: ${schedule.id} (pending context written)`);
    }
  }

  addSchedule(schedule: Schedule) {
    const store = loadSchedules();

    // Remove existing with same ID
    store.schedules = store.schedules.filter((s) => s.id !== schedule.id);
    store.schedules.push(schedule);
    saveSchedules(store);

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

    // Remove from store
    const store = loadSchedules();
    store.schedules = store.schedules.filter((s) => s.id !== id);
    saveSchedules(store);

    log(`Removed schedule: ${id}`);
  }

  private startFileWatcher() {
    const entitiesDir = getEntitiesDir();
    const watchPaths = [join(entitiesDir, "**", "*.md")];

    this.watcher = watch(watchPaths, {
      ignoreInitial: true,
      persistent: true,
    });

    this.watcher.on("all", (event, path) => {
      log(`File ${event}: ${path}`);
      // TODO: Trigger reindex of the changed file
      this.queueReindex(path);
    });

    log(`Watching for entity changes in: ${entitiesDir}`);
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
    for (const path of paths) {
      try {
        await indexEntityFile(path);
        log(`  ✓ ${basename(path)}`);
      } catch (err) {
        log(`  ✗ ${basename(path)}: ${String(err)}`);
      }
    }
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
