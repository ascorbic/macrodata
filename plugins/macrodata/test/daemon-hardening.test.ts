/**
 * Regression tests for daemon hardening (#25).
 *
 * The daemon previously wedged forever when a spawned agent child hung, and
 * the plugin had no way to detect a dead-but-PID-alive daemon. These tests
 * cover the child hard-timeout, the heartbeat file, and survival of child
 * failures.
 */

import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { spawn } from "child_process";
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

  afterEach(() => {
    if (daemonPid) {
      stopDaemon(daemonPid);
      daemonPid = null;
    }
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

  test("keeps running after a child that exits with an error", async () => {
    const fakeBinDir = join(ctx.root, "fake-bin");
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeOpencode = join(fakeBinDir, "opencode");
    writeFileSync(fakeOpencode, "#!/bin/sh\necho boom >&2\nexit 1\n", { mode: 0o755 });

    daemonPid = await startDaemon(ctx, { PATH: `${fakeBinDir}:${process.env.PATH}` });
    expect(daemonPid).not.toBeNull();

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
