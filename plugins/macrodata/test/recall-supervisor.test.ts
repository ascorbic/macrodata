/**
 * recall-supervisor.sh — worker version lifecycle.
 *
 * The supervisor identifies workers by `ps` argv (sentinel + state root), and
 * decides what to do with each by WHERE its source lives. These tests pin that
 * classification, because the failure it guards against is invisible from the
 * outside: a worker running a different copy of the source looks exactly like a
 * healthy one, which is how an upgraded plugin can serve recall from code the
 * release does not contain.
 *
 * Every test points MACRODATA_ROOT at a temp dir, so the fakes here can never be
 * confused with a worker serving a real store — the supervisor only ever counts
 * workers whose argv names its own root.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync, execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { createTestContext, type TestContext } from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const SUPERVISOR = join(PLUGIN_ROOT, "bin", "recall-supervisor.sh");
const WORKER = join(PLUGIN_ROOT, "src", "recall", "worker.ts");
const SENTINEL = "--macrodata-recall-worker";

/** Every process whose argv claims to be a worker for `root`. */
function workersFor(root: string): { pid: number; cmd: string }[] {
  const out = execSync("ps -ww -eo pid=,command=", { encoding: "utf-8" });
  return out.split("\n").flatMap((line) => {
    if (!line.includes(`${SENTINEL} ${root}`)) return [];
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), cmd: m[2] }] : [];
  });
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

async function waitForWorker(root: string, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const found = workersFor(root).filter((w) => w.cmd.includes(WORKER));
    if (found.length > 0) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  return workersFor(root).filter((w) => w.cmd.includes(WORKER));
}

/**
 * A long-lived process whose argv is `fakeCmd` — `exec -a` sets argv[0], which
 * is what `ps -o command=` reports, so the supervisor classifies it by that
 * spoofed source path without a real worker ever starting.
 *
 * Backgrounded inside a shell that then exits, so the fake is an orphan like a
 * real worker (whose spawning hook shell is long gone) rather than a child of
 * this test. A child would linger as a zombie until Bun reaps it, `kill -0`
 * reports a zombie as alive, and the blocking spawnSync below stops Bun from
 * reaping — so an owned fake makes a successful kill look like a failed one.
 */
async function spawnFakeWorker(fakeCmd: string, root: string, body = "sleep 30"): Promise<number> {
  const before = new Set(workersFor(root).map((w) => w.pid));
  spawnSync("bash", ["-c", `(exec -a "${fakeCmd}" ${body}) &`], { stdio: "ignore" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = workersFor(root).filter((w) => !before.has(w.pid));
    if (found.length === 1) return found[0]?.pid as number;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`fake worker never appeared in ps: ${fakeCmd}`);
}

/** Same, but it traps SIGTERM: only the SIGKILL escalation can stop it. */
function spawnWedgedWorker(fakeCmd: string, root: string): Promise<number> {
  return spawnFakeWorker(fakeCmd, root, `bash -c 'trap "" TERM; while :; do sleep 1; done'`);
}

function runSupervisor(root: string) {
  const r = spawnSync("bash", [SUPERVISOR], {
    encoding: "utf-8",
    env: { ...process.env, MACRODATA_ROOT: root, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function supervisorLog(root: string): string {
  const f = join(root, ".recall", "supervisor.log");
  return existsSync(f) ? readFileSync(f, "utf-8") : "";
}

describe("recall-supervisor worker version lifecycle", () => {
  let ctx: TestContext;

  const staleCmd = (root: string) =>
    `bun run /Users/x/.claude/plugins/cache/macrodata/macrodata/0.0.1/src/recall/worker.ts ${SENTINEL} ${root}`;
  const devCmd = (root: string) =>
    `bun run /home/dev/checkout/plugins/macrodata/src/recall/worker.ts ${SENTINEL} ${root}`;
  const mineCmd = (root: string) => `bun run ${WORKER} ${SENTINEL} ${root}`;

  beforeEach(() => {
    ctx = createTestContext("macrodata-supervisor-");
  });

  afterEach(() => {
    // Anything still claiming this root, real or fake. The root is unique per
    // test, so this can never reach a worker serving someone's actual store.
    for (const w of workersFor(ctx.root)) {
      try {
        process.kill(w.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    ctx.cleanup();
  });

  test("reaps a worker from another plugin version and respawns this one", async () => {
    const stale = await spawnFakeWorker(staleCmd(ctx.root), ctx.root);
    expect(workersFor(ctx.root).some((w) => w.pid === stale)).toBe(true); // the argv spoof took

    runSupervisor(ctx.root);

    expect(await waitGone(stale)).toBe(true);
    const fresh = await waitForWorker(ctx.root);
    expect(fresh.length).toBe(1);
    expect(fresh[0]?.pid).not.toBe(stale);
    expect(supervisorLog(ctx.root)).toContain("stale plugin-cache worker");
    expect(supervisorLog(ctx.root)).not.toContain("reap FAILED");
  });

  test("escalates to SIGKILL for a stale worker that ignores SIGTERM", async () => {
    const wedge = await spawnWedgedWorker(staleCmd(ctx.root), ctx.root);

    runSupervisor(ctx.root);

    expect(await waitGone(wedge)).toBe(true);
    expect(supervisorLog(ctx.root)).not.toContain("reap FAILED");
  });

  test("leaves a hand-started worker alone, spawns no competitor, and says so", async () => {
    const dev = await spawnFakeWorker(devCmd(ctx.root), ctx.root);

    const { stdout } = runSupervisor(ctx.root);

    expect(alive(dev)).toBe(true);
    // The announcement is the whole point: silence here is indistinguishable
    // from a healthy installed worker.
    expect(stdout).toContain("hand-started worker");
    expect(stdout).toContain(String(dev));
    expect(workersFor(ctx.root).map((w) => w.pid)).toEqual([dev]);
  });

  test("keeps the lowest-PID duplicate of this version and reaps the rest", async () => {
    const a = await spawnFakeWorker(mineCmd(ctx.root), ctx.root);
    const b = await spawnFakeWorker(mineCmd(ctx.root), ctx.root);
    const [keep, drop] = a < b ? [a, b] : [b, a];

    runSupervisor(ctx.root);

    expect(await waitGone(drop as number)).toBe(true);
    expect(alive(keep as number)).toBe(true);
    expect(supervisorLog(ctx.root)).toContain(`keep ${keep}`);
  });

  test("starts a worker when none is running", async () => {
    runSupervisor(ctx.root);

    expect((await waitForWorker(ctx.root)).length).toBe(1);
    expect(supervisorLog(ctx.root)).toContain("down -> starting");
  });
});
