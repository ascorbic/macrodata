/**
 * The worker's single-serving-process claim (src/recall/worker.ts).
 *
 * macrodata-hook.sh converges the worker on every prompt, so concurrent sessions
 * on one state root can each observe the same worker-less window and spawn into
 * it. The hook's own duplicate reap cleans that up a pass later, which is too
 * late to matter: by then every worker in the burst has its own copy of the embed
 * and rerank models. These pin the claim that stops the burst at the source.
 *
 * Each test gets its own state root, so a claim here can never collide with the
 * worker serving a real store.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawn, spawnSync, type ChildProcess } from "child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, utimesSync } from "fs";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const WORKER = join(PLUGIN_ROOT, "src", "recall", "worker.ts");

let root: string;
let spawned: ChildProcess[] = [];

/**
 * A worker exactly as the hook starts one, argv sentinel included.
 *
 * `MACRODATA_ROOT` is the one deliberate difference: the hook passes the root as
 * argv only, as a `ps` label, and lets the worker resolve its own root — which
 * here would be whichever store this machine really uses, so the test would claim
 * the slot of the worker serving it. The argv root is pinned to the same value so
 * the label cannot drift from the store under test.
 */
function startWorker(): ChildProcess {
  const p = spawn("bun", ["run", WORKER, "--macrodata-recall-worker", root], {
    cwd: PLUGIN_ROOT,
    env: { ...process.env, MACRODATA_ROOT: root },
    stdio: ["ignore", "pipe", "pipe"],
  });
  spawned.push(p);
  return p;
}

const pidPath = () => join(root, ".recall", "worker.pid");

function readPidFile(): string {
  return existsSync(pidPath()) ? readFileSync(pidPath(), "utf-8").trim() : "";
}

/**
 * Whether the process is gone, by either door. Kept distinct from "exited 0" so
 * a worker the afterEach SIGKILLs can never be read as one that stood down on
 * its own — the difference is the entire claim.
 */
const gone = (p: ChildProcess) => p.exitCode !== null || p.signalCode !== null;
const stoodDown = (p: ChildProcess) => p.exitCode === 0 && p.signalCode === null;

async function waitFor(pred: () => boolean, ms = 15000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return pred();
}

/** A PID that is definitely dead: a process run to completion, then reaped. */
function deadPid(): number {
  const r = spawnSync("bash", ["-c", "exit 0"]);
  return r.pid as number;
}

describe("recall worker single-instance claim", () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "macrodata-worker-lock-"));
    mkdirSync(join(root, ".recall"), { recursive: true });
  });

  afterEach(() => {
    for (const p of spawned) {
      try {
        p.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
    spawned = [];
    rmSync(root, { recursive: true, force: true });
  });

  test("a second worker on the same root exits instead of doubling the models", async () => {
    const first = startWorker();
    expect(await waitFor(() => readPidFile() === String(first.pid))).toBe(true);

    const second = startWorker();

    expect(await waitFor(() => stoodDown(second))).toBe(true);
    // The loser leaves the winner's claim untouched — its own exit handler must
    // not treat someone else's pidfile as its own.
    expect(readPidFile()).toBe(String(first.pid));
    expect(gone(first)).toBe(false);
  }, 30000);

  test("workers spawned together settle on one survivor", async () => {
    // Both start before either can claim: the stampede the hook's per-prompt
    // convergence makes possible, not a sequential second start.
    const a = startWorker();
    const b = startWorker();

    expect(await waitFor(() => stoodDown(a) || stoodDown(b))).toBe(true);
    const [loser, survivor] = stoodDown(a) ? [a, b] : [b, a];

    // Give the survivor a window to fall over too — the claim is only worth
    // anything if the burst settles on one worker rather than on none.
    expect(await waitFor(() => gone(survivor), 2000)).toBe(false);
    expect(readPidFile()).toBe(String(survivor.pid));
    expect(stoodDown(loser)).toBe(true);
  }, 30000);

  test("a claim whose process is gone is taken over, not obeyed", async () => {
    // How a reaped worker always leaves the file: the hook stops a stale-version
    // worker with SIGKILL, which runs no cleanup.
    writeFileSync(pidPath(), `${deadPid()}\n`);

    const w = startWorker();

    expect(await waitFor(() => readPidFile() === String(w.pid))).toBe(true);
    expect(gone(w)).toBe(false);
  }, 30000);

  // Only `request-` files are consumed by the protocol; an inbox nobody drained
  // and the two per-session baselines are left behind by every session that ends,
  // forever, and the worker's 5s sweep reads the whole directory each time.
  test("sweeps mailbox files left by sessions that have ended, and keeps live ones", async () => {
    const mailbox = join(root, ".recall", "mailbox");
    mkdirSync(mailbox, { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    const orphans = ["inbox-gone.json", "exclude-gone.json", "injected-gone.json", "request-gone.json.1234.tmp"];
    for (const f of orphans) {
      writeFileSync(join(mailbox, f), "{}");
      utimesSync(join(mailbox, f), old, old);
    }
    // A live session's file: same name shape, current mtime. The hook rewrites
    // its baselines on every fire, so mtime is the whole difference between a
    // session that ended and one still going.
    writeFileSync(join(mailbox, "inbox-live.json"), "{}");

    startWorker();

    expect(await waitFor(() => orphans.every((f) => !existsSync(join(mailbox, f))))).toBe(true);
    expect(existsSync(join(mailbox, "inbox-live.json"))).toBe(true);
  }, 30000);

  /** Quarantined requests, whose names carry a timestamp to stay distinct. */
  const quarantinesIn = (mailbox: string) =>
    readdirSync(mailbox).filter((f) => f.startsWith("request-") && f.endsWith(".bad"));

  // Nothing else consumes a request file, so one the worker cannot parse is found
  // again by every 5s sweep for the life of the process — and the only trim on
  // worker.log runs on the spawn path, which a healthy worker never reaches.
  test("quarantines a request file it cannot parse instead of re-reading it forever", async () => {
    const mailbox = join(root, ".recall", "mailbox");
    mkdirSync(mailbox, { recursive: true });
    const bad = join(mailbox, "request-abc.json");
    writeFileSync(bad, '{"search": "truncated mid-w');

    startWorker();

    expect(await waitFor(() => quarantinesIn(mailbox).length === 1)).toBe(true);
    expect(existsSync(bad)).toBe(false);
  }, 30000);

  // The name a quarantine lands under carries a timestamp because the request
  // name does not identify the content: the hook reuses `request-<sid>.json` for
  // every prompt in a session, so a fixed `.bad` destination means the second
  // unparseable request of a session silently overwrites the first — and a
  // quarantine exists to be read afterwards.
  test("keeps each quarantined request rather than overwriting the last", async () => {
    const mailbox = join(root, ".recall", "mailbox");
    mkdirSync(mailbox, { recursive: true });
    const bad = join(mailbox, "request-abc.json");

    writeFileSync(bad, '{"search": "first truncated mid-w');
    startWorker();
    expect(await waitFor(() => quarantinesIn(mailbox).length === 1)).toBe(true);

    writeFileSync(bad, '{"search": "second truncated mid-w');
    expect(await waitFor(() => quarantinesIn(mailbox).length === 2)).toBe(true);

    // Both bodies still readable is the property; two distinct names is only how
    // it is achieved.
    const bodies = quarantinesIn(mailbox)
      .map((f) => readFileSync(join(mailbox, f), "utf-8"))
      .sort();
    expect(bodies).toEqual([
      '{"search": "first truncated mid-w',
      '{"search": "second truncated mid-w',
    ]);
  }, 30000);

  test("SIGTERM releases the claim", async () => {
    const w = startWorker();
    expect(await waitFor(() => readPidFile() === String(w.pid))).toBe(true);

    w.kill("SIGTERM");
    expect(await waitFor(() => stoodDown(w))).toBe(true);
    expect(await waitFor(() => readPidFile() === "")).toBe(true);
  }, 30000);
});
