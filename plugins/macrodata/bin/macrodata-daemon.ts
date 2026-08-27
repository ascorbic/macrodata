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
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join, basename } from "path";
import { Cron } from "croner";
import { spawn, execSync } from "child_process";
import { indexEntityFile, preloadModel } from "../src/indexer.js";
import { getStateRoot, getEntitiesDir, getJournalDir, getIndexDir, getRemindersDir } from "../src/config.js";
import { updateConversationIndex as updateOpenCodeConversations } from "../opencode/conversations.js";
import { updateConversationIndex as updateClaudeCodeConversations } from "../src/conversations.js";

/**
 * Find an executable in PATH
 */
async function findExecutable(name: string): Promise<string | null> {
  try {
    const result = execSync(`which ${name}`, { encoding: "utf-8" }).trim();
    return result || null;
  } catch {
    return null;
  }
}

// Daemon-specific path helpers
// Use MACRODATA_ROOT for all daemon files (PID, log) to support testing with isolated directories
function getDaemonDir() {
  return getStateRoot();
}

function parseRedFlags(markdown: string): string[] {
  const flags: string[] = [];
  let inRed = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      inRed = line.includes("🔴");
      continue;
    }
    if (inRed && line.startsWith("- ")) {
      const name = line.match(/\*\*(.+?)\*\*/)?.[1] ?? line.slice(2);
      flags.push(name.trim());
    }
  }
  return flags;
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

function getHeartbeatFile() {
  return join(getDaemonDir(), ".daemon.heartbeat");
}

const HEARTBEAT_INTERVAL_MS = 60_000;

const CHILD_TIMEOUT_MS = (() => {
  const raw = process.env.MACRODATA_CHILD_TIMEOUT_MS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10 * 60_000;
})();

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string; // cron expression or ISO datetime
  description: string;
  payload: string;
  agent?: "opencode" | "claude"; // Which agent to trigger
  model?: string; // Optional model override (e.g., "anthropic/claude-opus-4-6")
  timeoutMs?: number; // Optional child timeout override for this schedule
  createdAt: string;
}

/**
 * Trigger an agent with a message
 */
async function triggerAgent(
  agent: "opencode" | "claude" | undefined,
  message: string,
  options: { model?: string; description?: string; timeoutMs?: number } = {}
): Promise<boolean> {
  if (!agent) {
    log("No agent specified in schedule, skipping trigger");
    return false;
  }

  const timestamp = new Date().toLocaleString();
  const fullMessage = `[Scheduled reminder: ${options.description || "reminder"}]
Current time: ${timestamp}

IMPORTANT: Use the macrodata_* tools (e.g., macrodata_log_journal, macrodata_search_memory) for memory operations. You are running in a non-interactive scheduled context.

${message}`;

  try {
    if (agent === "opencode") {
      // opencode run "message" --model provider/model
      const args = ["run", fullMessage];
      if (options.model) {
        args.push("--model", options.model);
      }
      
      // Find opencode in PATH or use npx as fallback
      const opencodePath = await findExecutable("opencode") || "npx";
      const finalArgs = opencodePath === "npx" ? ["opencode", ...args] : args;
      
      log(`Triggering OpenCode: ${opencodePath} ${finalArgs.join(" ").substring(0, 50)}...`);
      
      spawnSupervisedChild(opencodePath, finalArgs, "opencode", options.timeoutMs);

      return true;
    } else if (agent === "claude") {
      // claude --print "message" or claude -p "message"
      const args = ["--print", fullMessage];
      
      log(`Triggering Claude Code: claude --print "..."`);
      
      spawnSupervisedChild("claude", args, "claude", options.timeoutMs);

      return true;
    }
  } catch (err) {
    logError(`Failed to trigger ${agent}: ${String(err)}`);
  }

  return false;
}

/**
 * Spawn an agent child process with a hard timeout so a hung child can never
 * wedge the daemon's scheduling (#25). The child runs in its own process
 * group; on timeout the whole group is killed and the daemon keeps running.
 */
function spawnSupervisedChild(
  command: string,
  args: string[],
  label: string,
  timeoutMs: number = CHILD_TIMEOUT_MS
) {
  const proc = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: { ...process.env, PATH: process.env.PATH },
  });

  proc.unref();

  const killTimer = setTimeout(() => {
    log(`[${label}] child exceeded ${timeoutMs}ms timeout, killing process group ${proc.pid}`);
    if (proc.pid) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Child already gone
        }
      }
    }
  }, timeoutMs);
  killTimer.unref();

  proc.stdout?.on("data", (data) => {
    log(`[${label} stdout] ${data.toString().trim()}`);
  });
  proc.stderr?.on("data", (data) => {
    log(`[${label} stderr] ${data.toString().trim()}`);
  });
  proc.on("error", (err) => {
    clearTimeout(killTimer);
    logError(`[${label}] child process error: ${String(err)}`);
  });
  proc.on("exit", (code, signal) => {
    clearTimeout(killTimer);
    log(`[${label}] child exited (code=${code}, signal=${signal})`);
  });
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
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private shouldRun = true;

  async start() {
    log("Starting macrodata local daemon");
    log(`State root: ${getStateRoot()}`);

    // Acquire the PID file atomically: an existsSync check followed by a
    // plain write lets two daemons started in the same instant both pass
    // the guard and run forever as duplicates, double-firing every cron.
    ensureDirectories();
    const pidFile = getPidFile();
    if (!this.acquirePidFile(pidFile)) {
      process.exit(0);
    }

    // Set up signal handlers
    process.on("SIGTERM", () => this.shutdown("SIGTERM"));
    process.on("SIGINT", () => this.shutdown("SIGINT"));
    process.on("SIGHUP", () => this.reload());

    // The daemon must be hard to stop: a failed child, watcher error, or
    // rejected background promise should be logged, never fatal (#25).
    process.on("unhandledRejection", (reason) => {
      logError(`Unhandled rejection (daemon continues): ${String(reason)}`);
    });
    process.on("uncaughtException", (err) => {
      logError(`Uncaught exception (daemon continues): ${String(err?.stack || err)}`);
    });

    // Preload embedding model and update conversation indexes in background
    preloadModel()
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

    // Heartbeat lets the plugin detect a dead/stale daemon and restart it
    this.startHeartbeat();

    // Keep process alive
    log("Daemon running");
  }

  private startHeartbeat() {
    const beat = () => {
      try {
        writeFileSync(getHeartbeatFile(), Date.now().toString());
      } catch (err) {
        logError(`Heartbeat write failed: ${String(err)}`);
      }
    };
    beat();
    this.heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
  }

  private acquirePidFile(pidFile: string): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(pidFile, process.pid.toString(), { flag: "wx" });
        return true;
      } catch {
        let existingPid = "";
        try {
          existingPid = readFileSync(pidFile, "utf-8").trim();
          process.kill(parseInt(existingPid, 10), 0);
          log(`Daemon already running (PID ${existingPid}), exiting`);
          return false;
        } catch {
          log(`Removing stale PID file (was ${existingPid || "unreadable"})`);
          try {
            unlinkSync(pidFile);
          } catch {}
        }
      }
    }
    log("Could not acquire PID file after retry, exiting");
    return false;
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

  private async fireSchedule(schedule: Schedule) {
    log(`Firing schedule: ${schedule.id} - ${schedule.description}`);

    // Trigger the agent specified in the schedule
    const triggered = await triggerAgent(schedule.agent, schedule.payload, {
      model: schedule.model,
      description: schedule.description,
      timeoutMs: schedule.timeoutMs,
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

      // State files (working memory) - inject content, capped so a mid-session
      // delta can't blow the context budget (mirrors the session-start cap).
      if (path.startsWith(stateDir)) {
        try {
          const raw = readFileSync(path, "utf-8");
          const cap = 4000;
          const content =
            raw.length > cap
              ? `${raw.slice(0, cap)}\n[…truncated: ${cap} of ${raw.length} chars. This file is over budget — compact it.]`
              : raw;
          const filename = basename(path);
          writePendingContext(`<macrodata-update type="state" file="${filename}">\n${content}\n</macrodata-update>`);
        } catch {}
        if (basename(path) === "flags.md") {
          this.notifyNewRedFlags(path);
        }
      }
      // Entity files - inject just the name
      else if (path.startsWith(entitiesDir)) {
        const relative = path.slice(entitiesDir.length + 1);
        writePendingContext(`<macrodata-update type="entity" file="${relative}" />`);
        this.queueReindex(path);
      }
    });

    log(`Watching for state/entity changes in: ${stateRoot}`);
  }

  /**
   * Red flags only reach the user if something interrupts them: scheduled
   * sessions write flags.md, but nothing reads it back to a human. Fire a
   * macOS notification for 🔴 bullets not seen before, tracked in
   * .flags-notified (outside the watched state/ dir).
   */
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
      const text = detail.replace(/["\\]/g, "").slice(0, 200);
      spawn("osascript", ["-e", `display notification "${text}" with title "macrodata: new red flag"`], {
        stdio: "ignore",
      }).unref();
      log(`Notified ${fresh.length} new red flag(s): ${fresh.join(" | ")}`);
    } catch (err) {
      logError(`Flag notification failed: ${String(err)}`);
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
    for (const path of paths) {
      try {
        await indexEntityFile(path);
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

  private shutdown(signal: string) {
    log(`Shutting down (${signal})`);
    this.shouldRun = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

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
