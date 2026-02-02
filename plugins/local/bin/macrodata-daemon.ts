#!/usr/bin/env bun
/**
 * Macrodata Local Daemon
 *
 * Handles scheduled tasks, file watching for index updates, and can trigger
 * Claude Code via CLI when reminders fire.
 *
 * Usage:
 *   MACRODATA_ROOT=~/.config/macrodata bun run macrodata-daemon.ts
 */

import { watch } from "chokidar";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "fs";
import { homedir } from "os";
import { join, basename, relative } from "path";
import { Cron } from "croner";
import { indexEntityFile, preloadModel } from "../src/indexer.js";

// Configuration
const STATE_ROOT = process.env.MACRODATA_ROOT || join(homedir(), ".config", "macrodata");
const PIDFILE = join(STATE_ROOT, ".daemon.pid");
const PENDING_CONTEXT = join(STATE_ROOT, ".pending-context");
const SCHEDULES_FILE = join(STATE_ROOT, ".schedules.json");
const INDEX_DIR = join(STATE_ROOT, ".index");
const ENTITIES_DIR = join(STATE_ROOT, "entities");
const JOURNAL_DIR = join(STATE_ROOT, "journal");

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string; // cron expression or ISO datetime
  description: string;
  payload: string;
  createdAt: string;
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
    appendFileSync(PENDING_CONTEXT, message + "\n");
  } catch (err) {
    log(`Failed to write pending context: ${err}`);
  }
}

function ensureDirectories() {
  const dirs = [STATE_ROOT, INDEX_DIR, ENTITIES_DIR, JOURNAL_DIR, join(ENTITIES_DIR, "people"), join(ENTITIES_DIR, "projects")];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log(`Created directory: ${dir}`);
    }
  }
}

function loadSchedules(): ScheduleStore {
  try {
    if (existsSync(SCHEDULES_FILE)) {
      return JSON.parse(readFileSync(SCHEDULES_FILE, "utf-8"));
    }
  } catch (err) {
    log(`Failed to load schedules: ${err}`);
  }
  return { schedules: [] };
}

function saveSchedules(store: ScheduleStore) {
  try {
    writeFileSync(SCHEDULES_FILE, JSON.stringify(store, null, 2));
  } catch (err) {
    log(`Failed to save schedules: ${err}`);
  }
}

class MacrodataLocalDaemon {
  private cronJobs: Map<string, Cron> = new Map();
  private watcher: ReturnType<typeof watch> | null = null;
  private shouldRun = true;

  async start() {
    log("Starting macrodata local daemon");
    log(`State root: ${STATE_ROOT}`);

    // Write PID file
    ensureDirectories();
    writeFileSync(PIDFILE, process.pid.toString());

    // Set up signal handlers
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());

    // Preload embedding model in background (don't block startup)
    preloadModel()
      .then(() => log("Embedding model preloaded"))
      .catch((err) => log(`Failed to preload embedding model: ${err}`));

    // Load and start schedules
    this.loadAndStartSchedules();

    // Start file watcher for entity changes
    this.startFileWatcher();

    // Keep process alive
    log("Daemon running");
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
        this.fireSchedule(schedule);
      });
      this.cronJobs.set(schedule.id, job);
      log(`Started cron job: ${schedule.id} (${schedule.expression})`);
    } catch (err) {
      log(`Failed to start cron job ${schedule.id}: ${err}`);
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
      this.cronJobs.set(schedule.id, job);
      log(`Scheduled one-shot: ${schedule.id} at ${schedule.expression}`);
    } catch (err) {
      log(`Failed to schedule one-shot ${schedule.id}: ${err}`);
    }
  }

  private fireSchedule(schedule: Schedule) {
    log(`Firing schedule: ${schedule.id}`);
    const message = `[macrodata] ⏰ Reminder: ${schedule.description}\n${schedule.payload}`;
    writePendingContext(message);

    // TODO: Optionally trigger Claude Code CLI here
    // const claude = process.env.CLAUDE_CODE_PATH || 'claude';
    // execSync(`${claude} --print "${schedule.payload}"`);
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
    const watchPaths = [join(ENTITIES_DIR, "**", "*.md")];

    this.watcher = watch(watchPaths, {
      ignoreInitial: true,
      persistent: true,
    });

    this.watcher.on("all", (event, path) => {
      log(`File ${event}: ${path}`);
      // TODO: Trigger reindex of the changed file
      this.queueReindex(path);
    });

    log(`Watching for entity changes in: ${ENTITIES_DIR}`);
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
      this.processReindexQueue();
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
        log(`  ✗ ${basename(path)}: ${err}`);
      }
    }
  }

  private shutdown() {
    log("Shutting down");
    this.shouldRun = false;

    // Stop all cron jobs
    for (const [id, job] of this.cronJobs) {
      job.stop();
    }
    this.cronJobs.clear();

    // Stop file watcher
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clean up PID file
    try {
      if (existsSync(PIDFILE)) {
        const pid = readFileSync(PIDFILE, "utf-8").trim();
        if (pid === process.pid.toString()) {
          require("fs").unlinkSync(PIDFILE);
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
