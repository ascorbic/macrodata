/**
 * macrodata-hook.sh — ambient-recall worker version lifecycle.
 *
 * The hook identifies workers by `ps` argv (sentinel + state root), and decides
 * what to do with each by WHERE its source lives. These tests pin that
 * classification, because the failure it guards against is invisible from the
 * outside: a worker running a different copy of the source looks exactly like a
 * healthy one, which is how an upgraded plugin can serve recall from code the
 * release does not contain.
 *
 * Every test points MACRODATA_ROOT at a temp dir, so the fakes here can never be
 * confused with a worker serving a real store — the hook only ever counts workers
 * whose argv names its own root.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import {
  createTestContext,
  recallWorkersFor as workersFor,
  spawnFakeRecallWorker as spawnFakeWorker,
  killRecallWorkers,
  RECALL_SENTINEL as SENTINEL,
  RECALL_WORKER as WORKER,
  type TestContext,
} from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const HOOK = join(PLUGIN_ROOT, "bin", "macrodata-hook.sh");

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

async function waitFor(pred: () => boolean, ms = 10000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
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
 * A fake worker that traps SIGTERM: only the SIGKILL escalation can stop it.
 *
 * The trap must be set by the process whose pid this returns, not by a child of
 * it — a nested shell would take the trap out of the signal's path and leave a
 * wedge that dies on the first SIGTERM, which is the one thing it must not do.
 */
function spawnWedgedWorker(fakeCmd: string, root: string): Promise<number> {
  return spawnFakeWorker(fakeCmd, root, `trap "" TERM; while :; do sleep 1; done`);
}

function runHook(root: string, arg: string) {
  const r = spawnSync("bash", [HOOK, arg], {
    encoding: "utf-8",
    input: "", // prompt-submit reads session_id off stdin; give it a closed one
    env: { ...process.env, MACRODATA_ROOT: root, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The standalone lever: converge the worker, announce, touch no daemon. */
const runWorkerPass = (root: string) => runHook(root, "recall-worker");

function recallLog(root: string): string {
  const f = join(root, ".recall", "supervisor.log");
  return existsSync(f) ? readFileSync(f, "utf-8") : "";
}

/** The worker's own single-instance claim, which the hook only ever invalidates. */
const claimPath = (root: string) => join(root, ".recall", "worker.pid");
function readClaim(root: string): string {
  return existsSync(claimPath(root)) ? readFileSync(claimPath(root), "utf-8").trim() : "";
}
function seedClaim(root: string, pid: number) {
  mkdirSync(join(root, ".recall"), { recursive: true });
  writeFileSync(claimPath(root), `${pid}\n`);
}

describe("recall worker version lifecycle", () => {
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
    killRecallWorkers(ctx.root);
    // prompt-submit starts a daemon too; it writes its own pidfile.
    const pidFile = join(ctx.root, ".daemon.pid");
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, "utf-8").trim()), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    ctx.cleanup();
  });

  test("reaps a worker from another plugin version and respawns this one", async () => {
    const stale = await spawnFakeWorker(staleCmd(ctx.root), ctx.root);
    expect(workersFor(ctx.root).some((w) => w.pid === stale)).toBe(true); // the argv spoof took

    runWorkerPass(ctx.root);

    expect(await waitGone(stale)).toBe(true);
    const fresh = await waitForWorker(ctx.root);
    expect(fresh.length).toBe(1);
    expect(fresh[0]?.pid).not.toBe(stale);
    expect(recallLog(ctx.root)).toContain("stale plugin-cache worker");
    expect(recallLog(ctx.root)).not.toContain("reap FAILED");
  });

  test("escalates to SIGKILL for a stale worker that ignores SIGTERM", async () => {
    const wedge = await spawnWedgedWorker(staleCmd(ctx.root), ctx.root);

    // Prove the wedge is wedged first. kill_verified logs nothing when it
    // escalates, so a fake that quietly answers SIGTERM would satisfy every
    // assertion below while testing none of the escalation.
    process.kill(wedge, "SIGTERM");
    expect(await waitFor(() => !alive(wedge), 500)).toBe(false);

    runWorkerPass(ctx.root);

    expect(await waitGone(wedge)).toBe(true);
    expect(recallLog(ctx.root)).not.toContain("reap FAILED");
  });

  test("leaves a hand-started worker alone, spawns no competitor, and says so", async () => {
    const dev = await spawnFakeWorker(devCmd(ctx.root), ctx.root);

    const { stdout } = runWorkerPass(ctx.root);

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

    runWorkerPass(ctx.root);

    expect(await waitGone(drop as number)).toBe(true);
    expect(alive(keep as number)).toBe(true);
    expect(recallLog(ctx.root)).toContain(`keep ${keep}`);
  });

  // Sentinel and root are matched at the END of the command, because every state
  // root is a prefix of its own siblings: under a substring match the worker
  // serving `<root>-work` reads as this root's own, so a pass would skip the spawn
  // it owes and, on a version mismatch, reap a worker belonging to another store.
  test("ignores the worker of a root this one is only a prefix of", async () => {
    const sibling = `${ctx.root}-work`;
    mkdirSync(sibling, { recursive: true });
    const neighbor = await spawnFakeWorker(mineCmd(sibling), sibling);

    try {
      runWorkerPass(ctx.root);

      const fresh = await waitForWorker(ctx.root);
      expect(fresh.length).toBe(1);
      expect(fresh[0]?.pid).not.toBe(neighbor);
      expect(alive(neighbor)).toBe(true);
    } finally {
      killRecallWorkers(sibling);
      rmSync(sibling, { recursive: true, force: true });
    }
  }, 30000);

  // The worker stands down when another process holds the claim, so a claim the
  // hook fails to invalidate is a permanent, silent recall outage rather than a
  // noisy one. Both directions are pinned: clearing too eagerly costs the
  // single-instance guarantee, clearing too rarely costs recall entirely.
  test("clears a claim held by a non-worker, so a PID reused after a reboot can't mute recall", async () => {
    // The test process: alive, and definitively not a worker for this root —
    // the same shape as a claim that outlived a reboot onto a recycled PID.
    seedClaim(ctx.root, process.pid);

    runWorkerPass(ctx.root);

    const fresh = await waitForWorker(ctx.root);
    expect(fresh.length).toBe(1);
    // Taking the slot is only possible because the hook cleared the impostor
    // first; otherwise the worker reads a live holder and exits.
    expect(await waitFor(() => readClaim(ctx.root) === String(fresh[0]?.pid))).toBe(true);
    expect(recallLog(ctx.root)).toContain(`claim held by pid ${process.pid}`);
    // Long enough that a worker which stands down reports as a failed assertion
    // rather than as a test timeout, which reads like flake.
  }, 30000);

  test("leaves a claim held by a live worker alone", async () => {
    const dev = await spawnFakeWorker(devCmd(ctx.root), ctx.root);
    seedClaim(ctx.root, dev);

    runWorkerPass(ctx.root);

    expect(readClaim(ctx.root)).toBe(String(dev));
  });

  test("starts a worker when none is running", async () => {
    runWorkerPass(ctx.root);

    expect((await waitForWorker(ctx.root)).length).toBe(1);
    expect(recallLog(ctx.root)).toContain("down -> starting");
  });

  // The reason the worker is managed from macrodata-hook.sh at all: SessionStart
  // does not fire on a plugin update + reload, so a manager that only runs there
  // keeps serving the previous version's code until a new session happens to open.
  test("prompt-submit rolls a stale worker, so an upgrade lands without a new session", async () => {
    const stale = await spawnFakeWorker(staleCmd(ctx.root), ctx.root);

    runHook(ctx.root, "prompt-submit");

    expect(await waitGone(stale)).toBe(true);
    const fresh = await waitForWorker(ctx.root);
    expect(fresh.length).toBe(1);
    expect(recallLog(ctx.root)).toContain("stale plugin-cache worker");
  });

  test("prompt-submit says nothing about a hand-started worker, and logs nothing when healthy", async () => {
    const dev = await spawnFakeWorker(devCmd(ctx.root), ctx.root);

    // stdout here is injected as context on EVERY message, so the session-start
    // announcement must not repeat per prompt.
    const { stdout } = runHook(ctx.root, "prompt-submit");
    expect(stdout).not.toContain("hand-started worker");
    expect(alive(dev)).toBe(true);

    // Same for the log: one entry per prompt would bury the entries that record
    // an actual decision. A healthy steady state is silent.
    process.kill(dev, "SIGKILL");
    await waitGone(dev);
    runWorkerPass(ctx.root); // spawn a real worker of this version
    expect((await waitForWorker(ctx.root)).length).toBe(1);
    const before = recallLog(ctx.root);
    runHook(ctx.root, "prompt-submit");
    expect(recallLog(ctx.root)).toBe(before);
  });
});
