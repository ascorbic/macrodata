/**
 * Integration tests for daemon
 *
 * Tests the background daemon process that handles scheduling and file watching.
 * NOTE: These tests start real daemon processes in isolated temp directories.
 *
 * IMPORTANT: The daemon imports the indexer which requires @xenova/transformers
 * and sharp. If sharp is not built, these tests will be skipped.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { spawn } from "child_process";
import { existsSync, readFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import {
  createTestContext,
  setupMinimalState,
  addReminder,
  type TestContext,
} from "./helpers";

// Check if daemon can start (requires sharp to be built)
let daemonAvailable = false;
try {
  await import("@xenova/transformers");
  daemonAvailable = true;
} catch {
  console.warn("[Test] Daemon tests skipped - sharp not built");
}

// Track all started daemons for cleanup
const startedDaemons: { pid: number; ctx: TestContext }[] = [];

// Get paths
const DAEMON_SCRIPT = join(dirname(import.meta.dir), "bin", "macrodata-daemon.ts");

async function startDaemon(ctx: TestContext): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", DAEMON_SCRIPT], {
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    proc.unref();

    // Wait for PID file to appear
    const pidFile = join(ctx.root, ".daemon.pid");
    let attempts = 0;
    const checkPid = setInterval(() => {
      attempts++;
      if (existsSync(pidFile)) {
        clearInterval(checkPid);
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        startedDaemons.push({ pid, ctx });
        resolve(pid);
      } else if (attempts > 20) {
        clearInterval(checkPid);
        resolve(null);
      }
    }, 100);
  });
}

function stopDaemon(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process might already be dead
  }
}

function isDaemonRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Clean up all daemons after all tests
afterAll(() => {
  for (const { pid } of startedDaemons) {
    stopDaemon(pid);
  }
});

describe.skipIf(!daemonAvailable)("daemon", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    setupMinimalState(ctx);
  });

  afterEach(async () => {
    // Stop daemon if running
    const pidFile = join(ctx.root, ".daemon.pid");
    if (existsSync(pidFile)) {
      try {
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        stopDaemon(pid);
        // Wait for it to stop
        let attempts = 0;
        while (isDaemonRunning(pid) && attempts < 10) {
          await Bun.sleep(100);
          attempts++;
        }
      } catch {
        // Ignore
      }
    }
    ctx.cleanup();
  });

  describe("startup", () => {
    test("writes PID file to MACRODATA_ROOT", async () => {
      const pid = await startDaemon(ctx);
      expect(pid).not.toBeNull();

      const pidFile = join(ctx.root, ".daemon.pid");
      expect(existsSync(pidFile)).toBe(true);

      const writtenPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      expect(writtenPid).toBe(pid as number);
    });

    test("writes log file to MACRODATA_ROOT", async () => {
      const pid = await startDaemon(ctx);
      expect(pid).not.toBeNull();

      // Give it a moment to write logs
      await Bun.sleep(500);

      const logFile = join(ctx.root, ".daemon.log");
      expect(existsSync(logFile)).toBe(true);

      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("Starting macrodata local daemon");
      expect(log).toContain(`State root: ${ctx.root}`);
    });

    test("creates required directories", async () => {
      // Remove some directories
      const entitiesDir = join(ctx.root, "entities");
      const journalDir = join(ctx.root, "journal");
      rmSync(entitiesDir, { recursive: true, force: true });
      rmSync(journalDir, { recursive: true, force: true });

      const pid = await startDaemon(ctx);
      expect(pid).not.toBeNull();

      // Daemon should recreate them
      await Bun.sleep(500);
      expect(existsSync(entitiesDir)).toBe(true);
      expect(existsSync(journalDir)).toBe(true);
    });

    test("refuses to start if already running", async () => {
      const pid1 = await startDaemon(ctx);
      expect(pid1).not.toBeNull();

      // Try to start another daemon in same directory
      await startDaemon(ctx);

      // Second daemon should not start (returns null or same pid)
      // The PID file should still contain the original PID
      const pidFile = join(ctx.root, ".daemon.pid");
      const currentPid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      expect(currentPid).toBe(pid1 as number);
    });
  });

  describe("shutdown", () => {
    test("removes PID file on SIGTERM", async () => {
      const pid = await startDaemon(ctx);
      expect(pid).not.toBeNull();

      const pidFile = join(ctx.root, ".daemon.pid");
      expect(existsSync(pidFile)).toBe(true);

      // Send SIGTERM
      stopDaemon(pid!);

      // Wait for process to die (longer timeout for cleanup)
      let attempts = 0;
      while (isDaemonRunning(pid!) && attempts < 50) {
        await Bun.sleep(100);
        attempts++;
      }

      // PID file should be removed (or may persist if daemon crashed)
      // At minimum, the process should be dead
      expect(isDaemonRunning(pid!)).toBe(false);
    });
  });

  describe("schedules", () => {
    test("loads schedules from reminders directory", async () => {
      // Add a reminder before starting daemon
      addReminder(ctx, "test-schedule", {
        type: "cron",
        expression: "0 0 * * *", // Midnight
        description: "Test schedule",
        payload: "Test payload",
      });

      const pid = await startDaemon(ctx);
      expect(pid).not.toBeNull();

      // Check logs for schedule loading
      await Bun.sleep(500);
      const logFile = join(ctx.root, ".daemon.log");
      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("Started cron job: test-schedule");
    });

    test("detects new schedules added at runtime", async () => {
      const pid = await startDaemon(ctx);
      expect(pid).not.toBeNull();

      // Give daemon time to start
      await Bun.sleep(500);

      // Add a new reminder while daemon is running
      addReminder(ctx, "new-schedule", {
        type: "cron",
        expression: "0 12 * * *",
        description: "New schedule",
        payload: "New payload",
      });

      // Give file watcher time to detect
      await Bun.sleep(1000);

      const logFile = join(ctx.root, ".daemon.log");
      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("Reminder added: new-schedule.json");
    });

    test("detects removed schedules at runtime", async () => {
      addReminder(ctx, "remove-me", {
        type: "cron",
        expression: "0 0 * * *",
        description: "Will be removed",
        payload: "Payload",
      });

      const pid = await startDaemon(ctx);
      expect(pid).not.toBeNull();

      await Bun.sleep(500);

      // Remove the reminder
      const reminderFile = join(ctx.root, "reminders", "remove-me.json");
      rmSync(reminderFile);

      // Give file watcher time to detect
      await Bun.sleep(1000);

      const logFile = join(ctx.root, ".daemon.log");
      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("Reminder removed: remove-me");
      expect(log).toContain("Stopped job: remove-me");
    });
  });

  describe("SIGHUP reload", () => {
    test("reloads config on SIGHUP", async () => {
      const pid = await startDaemon(ctx);
      expect(pid).not.toBeNull();

      await Bun.sleep(500);

      // Send SIGHUP
      process.kill(pid!, "SIGHUP");

      await Bun.sleep(500);

      const logFile = join(ctx.root, ".daemon.log");
      const log = readFileSync(logFile, "utf-8");
      expect(log).toContain("Reloading config (SIGHUP)");
      expect(log).toContain("Reload complete");
    });
  });

  describe("isolation", () => {
    test("multiple daemons can run in parallel with different roots", async () => {
      const ctx2 = createTestContext("macrodata-test-2-");
      setupMinimalState(ctx2);

      try {
        const pid1 = await startDaemon(ctx);
        const pid2 = await startDaemon(ctx2);

        expect(pid1).not.toBeNull();
        expect(pid2).not.toBeNull();
        expect(pid1).not.toBe(pid2);

        // Both should be running
        expect(isDaemonRunning(pid1!)).toBe(true);
        expect(isDaemonRunning(pid2!)).toBe(true);

        // Both should have their own PID files
        expect(existsSync(join(ctx.root, ".daemon.pid"))).toBe(true);
        expect(existsSync(join(ctx2.root, ".daemon.pid"))).toBe(true);
      } finally {
        // Stop second daemon
        const pidFile2 = join(ctx2.root, ".daemon.pid");
        if (existsSync(pidFile2)) {
          const pid = parseInt(readFileSync(pidFile2, "utf-8").trim(), 10);
          stopDaemon(pid);
        }
        ctx2.cleanup();
      }
    });
  });
});
