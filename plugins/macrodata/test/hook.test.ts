/**
 * Integration tests for the hook script (macrodata-hook.sh)
 *
 * As of the per-file-hook sharding, macrodata-hook.sh no longer composes the
 * memory context. session-start only manages the daemon + emits the first-run
 * nudge; prompt-submit only injects daemon-written pending context. State is
 * delivered by compose-state-file.ts / compose-lists.ts (tested separately).
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync, spawn } from "child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addReminder,
  seedHealthyRecallWorker,
  killRecallWorkers,
  type TestContext,
} from "./helpers";

const HOOK_SCRIPT = join(dirname(import.meta.dir), "bin", "macrodata-hook.sh");

// `stdin` feeds the hook's stdin JSON (where prompt-submit reads session_id).
// Always pass something — an empty pipe gives jq an immediate EOF so it never
// blocks waiting for input.
function runHook(
  ctx: TestContext,
  command: "session-start" | "prompt-submit",
  stdin = ""
): string {
  try {
    return execSync(`MACRODATA_ROOT="${ctx.root}" bash "${HOOK_SCRIPT}" ${command}`, {
      encoding: "utf-8",
      timeout: 10000,
      input: stdin,
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
    });
  } catch (err: unknown) {
    const error = err as { stdout?: string; stderr?: string };
    return error.stdout || "";
  }
}

// Async variant for true-concurrency tests — runs the hook in a real child
// process so several can race the claim simultaneously (execSync is blocking).
function runHookAsync(
  ctx: TestContext,
  command: "session-start" | "prompt-submit",
  stdin = ""
): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("bash", [HOOK_SCRIPT, command], {
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(out));
    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("hook script", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    ctx = createTestContext();
    setupMinimalState(ctx);
    // Both hook events converge the recall worker. This suite is about the
    // daemon, pending context and reminders, so stand a healthy worker in front
    // of it — otherwise every test here spawns a real model-loading one.
    // Supervision itself is covered by recall-worker-lifecycle.test.ts.
    await seedHealthyRecallWorker(ctx);
  });

  afterEach(() => {
    killRecallWorkers(ctx.root);
    // Kill any daemon that might have started
    const pidFile = join(ctx.root, ".daemon.pid");
    if (existsSync(pidFile)) {
      try {
        const pid = readFileSync(pidFile, "utf-8").trim();
        execSync(`kill ${pid} 2>/dev/null || true`);
      } catch {
        // Ignore
      }
    }
    ctx.cleanup();
  });

  describe("session-start", () => {
    test("emits no inline context when configured (state comes from per-file hooks)", () => {
      // The monolithic composer was removed: identity/today/human/workspace,
      // journal/schedules, usage, and files each have their own SessionStart
      // hook now. With identity present, this hook only manages the daemon and
      // emits nothing to stdout.
      expect(runHook(ctx, "session-start").trim()).toBe("");
    });

    test("does not emit the old monolithic <macrodata> sections", () => {
      addJournalEntry(ctx, "t", "x");
      addReminder(ctx, "r", { type: "cron", expression: "0 9 * * *", description: "d", payload: "p" });
      const output = runHook(ctx, "session-start");
      for (const tag of [
        "<macrodata-identity>",
        "<macrodata-today>",
        "<macrodata-journal>",
        "<macrodata-schedules>",
        "<macrodata-files",
      ]) {
        expect(output).not.toContain(tag);
      }
    });

    test("does not write the legacy .claude-context.md / lastmod files", () => {
      runHook(ctx, "session-start");
      expect(existsSync(join(ctx.root, ".claude-context.md"))).toBe(false);
      expect(existsSync(join(ctx.root, ".context-lastmod.json"))).toBe(false);
    });
  });

  describe("first-run detection", () => {
    test("shows the first-run nudge when there is no identity file", () => {
      const identityFile = join(ctx.stateDir, "identity.md");
      if (existsSync(identityFile)) unlinkSync(identityFile);

      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-first-run");
      expect(output).toContain("/onboarding");
    });
  });

  describe("prompt-submit", () => {
    test("injects pending daemon context and clears it", () => {
      const pendingFile = join(ctx.root, ".pending-context");
      writeFileSync(pendingFile, "<macrodata-update>Test update</macrodata-update>\n");

      const output = runHook(ctx, "prompt-submit");
      expect(output).toContain("Test update");

      const remaining = existsSync(pendingFile) ? readFileSync(pendingFile, "utf-8") : "";
      expect(remaining).toBe("");
    });

    // No daemon is started first, deliberately: its watcher DOES re-inject a
    // changed state file through .pending-context (macrodata-daemon.ts), so a
    // live daemon here would make this assert the opposite of what it means.
    // What's pinned is narrower — the hook never reads state files itself. The
    // write lands before prompt-submit starts a daemon, so nothing is watching
    // when it happens.
    test("never composes state itself (state is SessionStart-only now)", () => {
      writeFileSync(join(ctx.stateDir, "today.md"), "# Today\n\nModified content for testing.\n");

      const output = runHook(ctx, "prompt-submit");
      expect(output).not.toContain("Modified content for testing");
    });
  });

  describe("prompt-submit scheduled-task reminders", () => {
    const SESSION = JSON.stringify({ session_id: "sess-1" });

    function writeReminder(name: string, content: string) {
      const dir = join(ctx.root, ".pending-reminders");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), content);
    }

    function remindersLeft(): string[] {
      const dir = join(ctx.root, ".pending-reminders");
      return existsSync(dir) ? readdirSync(dir) : [];
    }

    test("injects a fired reminder and claims (removes) it", () => {
      writeReminder("dreamtime__1000", "<macrodata-scheduled-task id=\"dreamtime\">run /dreamtime</macrodata-scheduled-task>\n");

      const output = runHook(ctx, "prompt-submit", SESSION);
      expect(output).toContain("run /dreamtime");
      // Claimed: original gone, no leftover .claimed.* files either.
      expect(remindersLeft()).toEqual([]);
    });

    test("claims exactly-once — a second session's drain sees nothing", () => {
      writeReminder("distill__1", "<x>claim-once-marker</x>\n");

      const first = runHook(ctx, "prompt-submit", JSON.stringify({ session_id: "a" }));
      expect(first).toContain("claim-once-marker");

      const second = runHook(ctx, "prompt-submit", JSON.stringify({ session_id: "b" }));
      expect(second).not.toContain("claim-once-marker");
    });

    test("injects every queued reminder in one drain", () => {
      writeReminder("a__1", "<x>FIRST-TASK</x>\n");
      writeReminder("b__2", "<x>SECOND-TASK</x>\n");

      const output = runHook(ctx, "prompt-submit", SESSION);
      expect(output).toContain("FIRST-TASK");
      expect(output).toContain("SECOND-TASK");
      expect(remindersLeft()).toEqual([]);
    });

    test("skips half-written tmp files and leftover .claimed files", () => {
      writeReminder(".dreamtime.tmp", "HALF-WRITTEN\n");
      writeReminder("x.claimed.deadsession.999", "ALREADY-CLAIMED\n");

      const output = runHook(ctx, "prompt-submit", SESSION);
      expect(output).not.toContain("HALF-WRITTEN");
      expect(output).not.toContain("ALREADY-CLAIMED");
    });

    test("a hostile session_id cannot escape the pending dir or break the claim", () => {
      writeReminder("dreamtime", "<x>HOSTILE-SID-MARKER</x>\n");

      // session_id is external (harness stdin) and lands in the claim filename;
      // a path-traversal / shell-metachar value must be neutralized, not honored.
      const output = runHook(
        ctx,
        "prompt-submit",
        JSON.stringify({ session_id: "../../../etc/x; rm -rf / $(touch pwned)" })
      );

      expect(output).toContain("HOSTILE-SID-MARKER"); // still claimed + emitted
      expect(remindersLeft()).toEqual([]); // claimed in-place, no orphan, no escape
    });

    test("concurrent drains claim a reminder exactly once (atomic-rename lock)", async () => {
      writeReminder("dreamtime", "<x>RACE-MARKER</x>\n");

      // Five sessions race the same single reminder file simultaneously.
      const outputs = await Promise.all(
        [1, 2, 3, 4, 5].map((i) =>
          runHookAsync(ctx, "prompt-submit", JSON.stringify({ session_id: `s${i}` }))
        )
      );

      const winners = outputs.filter((o) => o.includes("RACE-MARKER")).length;
      expect(winners).toBe(1); // exactly one session emits it, never two
      expect(remindersLeft()).toEqual([]); // claimed + removed, no orphan
    });
  });

  describe("daemon version lifecycle (GH #12)", () => {
    // Spawn a fake long-lived process whose argv looks like a daemon at
    // `fakeCmd`, and point the PID file at it — simulates a daemon already
    // running from a particular version/path. `exec -a` sets argv[0] so
    // `ps -o command=` reports it. (Uses prompt-submit, not session-start, to
    // avoid the SIGHUP reload — which would kill the fake `sleep` for the
    // wrong reason.)
    function spawnFakeDaemon(fakeCmd: string): number {
      const child = spawn("bash", ["-c", `exec -a "${fakeCmd}" sleep 30`], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      writeFileSync(join(ctx.root, ".daemon.pid"), String(child.pid));
      return child.pid as number;
    }

    // A stale daemon that IGNORES SIGTERM — only SIGKILL stops it. exec replaces
    // the outer shell (same PID) with a bash that traps TERM, so `kill` is a
    // no-op and the hook must escalate to `kill -9`.
    function spawnWedgedDaemon(fakeCmd: string): number {
      const child = spawn(
        "bash",
        ["-c", `exec -a "${fakeCmd}" bash -c 'trap "" TERM; while :; do sleep 1; done'`],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      writeFileSync(join(ctx.root, ".daemon.pid"), String(child.pid));
      return child.pid as number;
    }

    function alive(pid: number): boolean {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }

    async function waitGone(pid: number, ms = 6000): Promise<boolean> {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (!alive(pid)) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return !alive(pid);
    }

    function argvOf(pid: number): string {
      try {
        return execSync(`ps -p ${pid} -o command=`, { encoding: "utf-8" });
      } catch {
        return "";
      }
    }

    function currentDaemonPid(): number | null {
      const f = join(ctx.root, ".daemon.pid");
      if (!existsSync(f)) return null;
      const pid = Number(readFileSync(f, "utf-8").trim());
      return Number.isFinite(pid) ? pid : null;
    }

    const STALE_CACHE_CMD =
      "bun run /Users/x/.claude/plugins/cache/macrodata/macrodata/0.0.1/bin/macrodata-daemon.ts";

    test("stops a stale plugin-cache daemon and respawns the current version", async () => {
      const stale = spawnFakeDaemon(STALE_CACHE_CMD);
      expect(argvOf(stale)).toContain("/plugins/cache/"); // the argv spoof actually took on this platform

      runHook(ctx, "prompt-submit");

      expect(await waitGone(stale)).toBe(true); // stale killed
      const fresh = currentDaemonPid();
      expect(fresh).not.toBeNull();
      expect(fresh).not.toBe(stale); // a DIFFERENT daemon now owns the pidfile
      expect(alive(fresh as number)).toBe(true); // ...and it's actually running
      const cmd = argvOf(fresh as number);
      expect(cmd).toContain("macrodata-daemon.ts");
      expect(cmd).not.toContain("/plugins/cache/"); // ...the current (non-stale) version
    });

    test("force-kills a stale daemon that ignores SIGTERM, then respawns (#2)", async () => {
      const wedge = spawnWedgedDaemon(STALE_CACHE_CMD);
      expect(argvOf(wedge)).toContain("/plugins/cache/");

      runHook(ctx, "prompt-submit");

      expect(await waitGone(wedge)).toBe(true); // SIGKILL escalation stopped it
      const fresh = currentDaemonPid();
      expect(fresh).not.toBe(wedge);
      expect(alive(fresh as number)).toBe(true); // respawned despite the wedge
    });

    test("leaves a hand-run dev daemon (outside the cache) alone", () => {
      const dev = spawnFakeDaemon(
        "bun run /home/dev/checkout/plugins/macrodata/bin/macrodata-daemon.ts"
      );
      expect(argvOf(dev)).toContain("/home/dev/checkout/"); // spoof took

      runHook(ctx, "prompt-submit");

      expect(alive(dev)).toBe(true); // not killed
      // ...and no competing daemon spawned — PID file still points at the dev one.
      expect(readFileSync(join(ctx.root, ".daemon.pid"), "utf-8").trim()).toBe(String(dev));
      try {
        process.kill(dev);
      } catch {
        /* afterEach also targets the pidfile pid */
      }
    });
  });
});
