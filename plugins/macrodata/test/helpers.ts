/**
 * Test helpers for macrodata integration tests
 *
 * Provides isolated test environments with temp directories
 */

import { execSync, spawnSync } from "child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

export interface TestContext {
  /** Root directory for this test (set as MACRODATA_ROOT) */
  root: string;
  /** State directory */
  stateDir: string;
  /** Entities directory */
  entitiesDir: string;
  /** Journal directory */
  journalDir: string;
  /** Index directory */
  indexDir: string;
  /** Reminders directory */
  remindersDir: string;
  /** Clean up the test directory */
  cleanup: () => void;
  /** Original env vars to restore */
  originalEnv: Record<string, string | undefined>;
}

/**
 * Create an isolated test environment with a temp directory
 *
 * Sets MACRODATA_ROOT env var and creates the directory structure.
 * Call cleanup() when done to remove the temp directory and restore env.
 */
export function createTestContext(prefix = "macrodata-test-"): TestContext {
  // Create temp directory
  const root = mkdtempSync(join(tmpdir(), prefix));

  // Create directory structure
  const stateDir = join(root, "state");
  const entitiesDir = join(root, "entities");
  const journalDir = join(root, "journal");
  const indexDir = join(root, ".index");
  const remindersDir = join(root, "reminders");

  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(entitiesDir, "people"), { recursive: true });
  mkdirSync(join(entitiesDir, "projects"), { recursive: true });
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(indexDir, { recursive: true });
  mkdirSync(remindersDir, { recursive: true });

  // Save original env
  const originalEnv = {
    MACRODATA_ROOT: process.env.MACRODATA_ROOT,
  };

  // Set test env
  process.env.MACRODATA_ROOT = root;

  return {
    root,
    stateDir,
    entitiesDir,
    journalDir,
    indexDir,
    remindersDir,
    originalEnv,
    cleanup: () => {
      // Restore env
      if (originalEnv.MACRODATA_ROOT === undefined) {
        delete process.env.MACRODATA_ROOT;
      } else {
        process.env.MACRODATA_ROOT = originalEnv.MACRODATA_ROOT;
      }

      // Remove temp directory
      try {
        rmSync(root, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    },
  };
}

/**
 * Create a minimal state setup for testing
 */
export function setupMinimalState(ctx: TestContext) {
  // Create identity file
  writeFileSync(
    join(ctx.stateDir, "identity.md"),
    `# Test Identity

A test agent for integration testing.

## Patterns

- Be concise
- Test thoroughly
`
  );

  // Create today file
  writeFileSync(
    join(ctx.stateDir, "today.md"),
    `# Today

## Now

Running integration tests.
`
  );

  // Create human file
  writeFileSync(
    join(ctx.stateDir, "human.md"),
    `# Human

Test user for integration testing.
`
  );

  // Create workspace file
  writeFileSync(
    join(ctx.stateDir, "workspace.md"),
    `# Workspace

## Active

- Integration testing
`
  );
}

/**
 * Create a test journal entry
 */
export function addJournalEntry(
  ctx: TestContext,
  topic: string,
  content: string,
  date?: Date
) {
  const entryDate = date || new Date();
  const dateStr = entryDate.toISOString().split("T")[0];
  const journalPath = join(ctx.journalDir, `${dateStr}.jsonl`);

  const entry = {
    timestamp: entryDate.toISOString(),
    topic,
    content,
    metadata: { source: "test" },
  };

  const line = JSON.stringify(entry) + "\n";

  if (existsSync(journalPath)) {
    const { appendFileSync } = require("fs");
    appendFileSync(journalPath, line);
  } else {
    writeFileSync(journalPath, line);
  }
}

/**
 * Create a test entity file
 */
export function addEntityFile(
  ctx: TestContext,
  type: string,
  name: string,
  content: string
) {
  const dir = join(ctx.entitiesDir, type);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), content);
}

/**
 * Create a test reminder
 */
export function addReminder(
  ctx: TestContext,
  id: string,
  options: {
    type: "cron" | "once";
    expression: string;
    description: string;
    payload: string;
    agent?: "claude" | "opencode";
  }
) {
  const reminder = {
    id,
    ...options,
    agent: options.agent || "claude",
    createdAt: new Date().toISOString(),
  };

  writeFileSync(
    join(ctx.remindersDir, `${id}.json`),
    JSON.stringify(reminder, null, 2)
  );
}

/** Path of the recall worker macrodata-hook.sh would spawn, and its ps marker. */
export const RECALL_SENTINEL = "--macrodata-recall-worker";
export const RECALL_WORKER = join(dirname(import.meta.dir), "src", "recall", "worker.ts");

/**
 * Every process whose argv claims to be a recall worker for `root`.
 *
 * Matched at the END of the command, exactly as macrodata-hook.sh does: the root
 * is the last argv the spawn passes, and a substring match would let `/x/mem`
 * count the worker serving `/x/mem-work` as its own.
 */
export function recallWorkersFor(root: string): { pid: number; cmd: string }[] {
  const out = execSync("ps -ww -eo pid=,command=", { encoding: "utf-8" });
  return out.split("\n").flatMap((line) => {
    if (!line.endsWith(`${RECALL_SENTINEL} ${root}`)) return [];
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    return m ? [{ pid: Number(m[1]), cmd: m[2] }] : [];
  });
}

/**
 * A long-lived process whose argv is `fakeCmd` — `exec -a` sets argv[0], which is
 * what `ps -o command=` reports, so macrodata-hook.sh classifies it by that
 * spoofed source path without a real worker ever starting.
 *
 * Backgrounded inside a shell that then exits, so the fake is an orphan like a
 * real worker (whose spawning hook shell is long gone) rather than a child of the
 * test. A child would linger as a zombie until Bun reaps it, `kill -0` reports a
 * zombie as alive, and a blocking spawnSync stops Bun from reaping — so an owned
 * fake makes a successful kill look like a failed one.
 *
 * `body` arrives on stdin rather than as arguments, because `exec -a` only sets
 * argv[0]: any argument would land after the state root and cost the fake the one
 * property that identifies it, since both the hook and `recallWorkersFor` require
 * the root to be the LAST thing in the command.
 */
export async function spawnFakeRecallWorker(
  fakeCmd: string,
  root: string,
  body = "sleep 30"
): Promise<number> {
  const before = new Set(recallWorkersFor(root).map((w) => w.pid));
  const script = JSON.stringify(body);
  spawnSync("bash", ["-c", `(printf '%s\\n' ${script} | exec -a "${fakeCmd}" bash) &`], {
    stdio: "ignore",
  });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const found = recallWorkersFor(root).filter((w) => !before.has(w.pid));
    if (found.length === 1) return found[0]?.pid as number;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`fake worker never appeared in ps: ${fakeCmd}`);
}

/**
 * Stand a fake worker of THIS version in front of the hook, so its per-prompt
 * convergence pass finds one up and returns without spawning. Suites that test
 * something other than worker supervision want this: a real spawn loads the embed
 * and rerank models, and the hook runs on every event they exercise.
 */
export function seedHealthyRecallWorker(ctx: TestContext): Promise<number> {
  return spawnFakeRecallWorker(
    `bun run ${RECALL_WORKER} ${RECALL_SENTINEL} ${ctx.root}`,
    ctx.root
  );
}

/** SIGKILL anything claiming `root`, fake or real. Unique roots keep this local. */
export function killRecallWorkers(root: string) {
  for (const w of recallWorkersFor(root)) {
    try {
      process.kill(w.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  sweepProcessesNaming(root);
}

/**
 * SIGKILL every process that mentions `root` anywhere in its command, whatever
 * shape its argv takes.
 *
 * Deliberately a coarser predicate than `recallWorkersFor`: a cleanup that shares
 * its matcher with the spawns it cleans up leaks every process the matcher gets
 * wrong, and leaks it silently, since the same blind spot hides the survivors from
 * the assertions too. A worker holds the embed and rerank models, so a leaked one
 * costs about a gigabyte until the machine reboots. Safe only because callers own
 * a freshly created temp root that nothing else on the machine names.
 */
export function sweepProcessesNaming(root: string) {
  const out = execSync("ps -ww -eo pid=,command=", { encoding: "utf-8" });
  for (const line of out.split("\n")) {
    if (!line.includes(root)) continue;
    const pid = Number(line.trim().match(/^(\d+)\s/)?.[1]);
    if (!pid || pid === process.pid || pid === process.ppid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
