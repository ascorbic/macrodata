/**
 * Regression tests for daemon hardening (#25).
 *
 * The daemon previously wedged forever when a spawned agent child hung, and
 * the plugin had no way to detect a dead-but-PID-alive daemon. These tests
 * cover the child hard-timeout, the heartbeat file, and survival of child
 * failures.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { createTestContext, type TestContext } from "./helpers";

let daemonAvailable = false;
try {
  await import("@xenova/transformers");
  daemonAvailable = true;
} catch {
  console.warn("[Test] Daemon hardening tests skipped - sharp not built");
}

const DAEMON_SCRIPT = join(dirname(import.meta.dir), "bin", "macrodata-daemon.ts");

const startedDaemons: { pid: number }[] = [];

async function startDaemon(ctx: TestContext, env: Record<string, string> = {}): Promise<number | null> {
  return new Promise((resolve) => {
    const proc = spawn("bun", ["run", DAEMON_SCRIPT], {
      env: {
        ...process.env,
        MACRODATA_ROOT: ctx.root,
        MACRODATA_OPENCODE_DB_PATH: join(ctx.root, "nonexistent-opencode.db"),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    proc.unref();

    const pidFile = join(ctx.root, ".daemon.pid");
    let attempts = 0;
    const checkPid = setInterval(() => {
      attempts++;
      if (existsSync(pidFile)) {
        clearInterval(checkPid);
        const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
        startedDaemons.push({ pid });
        resolve(pid);
      } else if (attempts > 30) {
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
    // Already dead
  }
}

async function killTestProcesses(ctx: TestContext, daemonPid: number | null): Promise<void> {
  // The daemon's kill-timers die with it, so SIGTERM alone can orphan spawned
  // agent children (and a daemon mid model-load is slow to honor SIGTERM);
  // anything still referencing this test's root starves later tests
  if (daemonPid) {
    stopDaemon(daemonPid);
    const dead = await waitFor(() => !isDaemonRunning(daemonPid), 3_000);
    if (!dead) {
      try {
        process.kill(daemonPid, "SIGKILL");
      } catch {
        // Already dead
      }
    }
  }
  spawnSync("pkill", ["-9", "-f", ctx.root]);
}

function isDaemonRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}

async function waitForDaemonIdle(ctx: TestContext): Promise<void> {
  // The daemon preloads the embedding model at startup, which can starve its
  // event loop for many seconds; schedule timers only fire reliably after it
  const logFile = join(ctx.root, ".daemon.log");
  await waitFor(() => {
    if (!existsSync(logFile)) return false;
    return readFileSync(logFile, "utf-8").includes("Embedding model preloaded");
  }, 30_000, 250);
}

afterAll(() => {
  for (const { pid } of startedDaemons) {
    stopDaemon(pid);
  }
});

describe.skipIf(!daemonAvailable)("daemon hardening", () => {
  let ctx: TestContext;
  let daemonPid: number | null = null;

  beforeEach(() => {
    ctx = createTestContext("macrodata-hardening-");
  });

  afterEach(async () => {
    await killTestProcesses(ctx, daemonPid);
    daemonPid = null;
    ctx.cleanup();
  });

  test("writes a heartbeat file on startup", async () => {
    daemonPid = await startDaemon(ctx);
    expect(daemonPid).not.toBeNull();

    const heartbeatFile = join(ctx.root, ".daemon.heartbeat");
    const appeared = await waitFor(() => existsSync(heartbeatFile), 10_000);
    expect(appeared).toBe(true);

    const beat = parseInt(readFileSync(heartbeatFile, "utf-8").trim(), 10);
    expect(Number.isFinite(beat)).toBe(true);
    expect(Date.now() - beat).toBeLessThan(120_000);
  });

  test("survives a hung agent child and kills it after the timeout (#25)", async () => {
    // A fake agent that ignores everything and sleeps forever
    const fakeBinDir = join(ctx.root, "fake-bin");
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeOpencode = join(fakeBinDir, "opencode");
    writeFileSync(fakeOpencode, "#!/bin/sh\nsleep 3600\n", { mode: 0o755 });

    daemonPid = await startDaemon(ctx, {
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      MACRODATA_CHILD_TIMEOUT_MS: "2000",
    });
    expect(daemonPid).not.toBeNull();

    // Fire a once-schedule immediately via the reminders dir
    await waitForDaemonIdle(ctx);

    const fireAt = new Date(Date.now() + 1500).toISOString();
    writeFileSync(
      join(ctx.remindersDir, "hang-test.json"),
      JSON.stringify({
        id: "hang-test",
        type: "once",
        expression: fireAt,
        description: "hang test",
        payload: "test payload",
        agent: "opencode",
        createdAt: new Date().toISOString(),
      })
    );

    const logFile = join(ctx.root, ".daemon.log");
    const childKilled = await waitFor(() => {
      if (!existsSync(logFile)) return false;
      const log = readFileSync(logFile, "utf-8");
      return log.includes("exceeded 2000ms timeout");
    }, 20_000, 250);

    expect(childKilled).toBe(true);
    expect(isDaemonRunning(daemonPid as number)).toBe(true);

    const log = readFileSync(logFile, "utf-8");
    expect(log).not.toContain("Shutting down");
  }, 30_000);

  test("per-schedule timeoutMs overrides the global child timeout", async () => {
    const fakeBinDir = join(ctx.root, "fake-bin");
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeOpencode = join(fakeBinDir, "opencode");
    writeFileSync(fakeOpencode, "#!/bin/sh\nsleep 3600\n", { mode: 0o755 });

    // Global timeout is long; only the schedule's own timeoutMs can kill the child quickly
    daemonPid = await startDaemon(ctx, {
      PATH: `${fakeBinDir}:${process.env.PATH}`,
      MACRODATA_CHILD_TIMEOUT_MS: "3600000",
    });
    expect(daemonPid).not.toBeNull();

    await waitForDaemonIdle(ctx);

    const fireAt = new Date(Date.now() + 1500).toISOString();
    writeFileSync(
      join(ctx.remindersDir, "per-schedule-timeout.json"),
      JSON.stringify({
        id: "per-schedule-timeout",
        type: "once",
        expression: fireAt,
        description: "per-schedule timeout test",
        payload: "test payload",
        agent: "opencode",
        timeoutMs: 2000,
        createdAt: new Date().toISOString(),
      })
    );

    const logFile = join(ctx.root, ".daemon.log");
    await waitFor(() => {
      if (!existsSync(logFile)) return false;
      const log = readFileSync(logFile, "utf-8");
      return log.includes("exceeded 2000ms timeout");
    }, 20_000, 250);

    // Assert on the log itself so a failure shows what the daemon did
    const log = existsSync(logFile) ? readFileSync(logFile, "utf-8") : "<no log file>";
    expect(log).toContain("exceeded 2000ms timeout");
    expect(isDaemonRunning(daemonPid as number)).toBe(true);
  }, 30_000);

  test("keeps running after a child that exits with an error", async () => {
    const fakeBinDir = join(ctx.root, "fake-bin");
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeOpencode = join(fakeBinDir, "opencode");
    writeFileSync(fakeOpencode, "#!/bin/sh\necho boom >&2\nexit 1\n", { mode: 0o755 });

    daemonPid = await startDaemon(ctx, { PATH: `${fakeBinDir}:${process.env.PATH}` });
    expect(daemonPid).not.toBeNull();

    await waitForDaemonIdle(ctx);

    const fireAt = new Date(Date.now() + 1500).toISOString();
    writeFileSync(
      join(ctx.remindersDir, "fail-test.json"),
      JSON.stringify({
        id: "fail-test",
        type: "once",
        expression: fireAt,
        description: "fail test",
        payload: "test payload",
        agent: "opencode",
        createdAt: new Date().toISOString(),
      })
    );

    const logFile = join(ctx.root, ".daemon.log");
    const childExited = await waitFor(() => {
      if (!existsSync(logFile)) return false;
      const log = readFileSync(logFile, "utf-8");
      return log.includes("child exited");
    }, 20_000, 250);

    expect(childExited).toBe(true);
    expect(isDaemonRunning(daemonPid as number)).toBe(true);
  }, 30_000);
});
