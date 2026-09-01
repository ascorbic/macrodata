/**
 * macrodata-hook.sh — bounding the recall logs without cutting the writer off.
 *
 * The recall logs are appended to by a process that outlives every hook run, so
 * trimming them is not the usual write-a-temp-file-and-rename: the worker holds
 * worker.log open with `>>` for its whole life, and a rename swaps the inode out
 * from under that fd. The worker keeps writing, to a file nothing can open, and
 * its log goes silent for the rest of the process — during the per-prompt failure
 * loop that is the only realistic way the file got large enough to trim.
 *
 * That makes the copy-back in trim_log load-bearing rather than stylistic, and
 * invisible from the outside: a rename passes every assertion about the trimmed
 * file's contents and fails only the writer, later. These hold the invariant the
 * implementation exists for, plus the convergence that keeps a trim from running
 * on every prompt forever.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "fs";
import { join } from "path";
import { createTestContext, killRecallWorkers, type TestContext } from "./helpers.ts";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const HOOK = join(PLUGIN_ROOT, "bin", "macrodata-hook.sh");

// Mirrored from macrodata-hook.sh rather than imported — they are shell
// constants, and a test that read them from the script could not fail when the
// script changed them, which is most of what these tests are for.
const MAX_BYTES = 1048576;
const KEEP_BYTES = 524288;

let ctx: TestContext;

const workerLog = (root: string) => join(root, ".recall", "worker.log");

/** The standalone lever: converge the worker, trim the logs, touch no daemon. */
function runHook(root: string) {
  const r = spawnSync("bash", [HOOK, "recall-worker"], {
    encoding: "utf-8",
    input: "",
    env: { ...process.env, MACRODATA_ROOT: root, CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT },
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** An NDJSON log of `bytes`, every line numbered so a cut line is recognizable. */
function writeLog(path: string, bytes: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  const pad = "x".repeat(200);
  let out = "";
  for (let n = 0; out.length < bytes; n++) {
    out += `${JSON.stringify({ n, pad })}\n`;
  }
  writeFileSync(path, out);
  return out;
}

describe("macrodata-hook.sh: recall log trimming", () => {
  beforeEach(() => {
    ctx = createTestContext("macrodata-log-trim-");
  });

  afterEach(() => {
    killRecallWorkers(ctx.root);
    ctx.cleanup();
  });

  test("leaves a log below the trigger exactly as it found it", () => {
    const p = workerLog(ctx.root);
    const before = writeLog(p, 4096);
    runHook(ctx.root);
    // Byte-identical, not merely small: a trim that rewrites a file it did not
    // need to touch is the multi-megabyte-rewrite-every-prompt bug in miniature.
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  test("brings an oversized log under the trigger in a single pass", () => {
    const p = workerLog(ctx.root);
    writeLog(p, MAX_BYTES * 3);
    runHook(ctx.root);
    const size = statSync(p).size;
    // Under the trigger is the whole point: trimming to a size that still trips
    // the trigger would rewrite the file on every prompt for as long as it lives.
    expect(size).toBeLessThanOrEqual(MAX_BYTES);
    expect(size).toBeLessThanOrEqual(KEEP_BYTES);
    expect(size).toBeGreaterThan(0);
  });

  test("a second pass over a trimmed log changes nothing", () => {
    const p = workerLog(ctx.root);
    writeLog(p, MAX_BYTES * 3);
    runHook(ctx.root);
    const trimmed = readFileSync(p, "utf-8");
    runHook(ctx.root);
    expect(readFileSync(p, "utf-8")).toBe(trimmed);
  });

  test("keeps every surviving line whole", () => {
    const p = workerLog(ctx.root);
    writeLog(p, MAX_BYTES * 3);
    runHook(ctx.root);
    // The cut is by bytes, so it lands mid-line; the first line of the tail is a
    // fragment and is dropped. Parsing every survivor is what proves it was.
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const ns = lines.map((l) => (JSON.parse(l) as { n: number }).n);
    // Contiguous and ending at the newest record: a tail that dropped more than
    // the leading fragment would show up as a gap here.
    expect(ns).toEqual(Array.from({ length: ns.length }, (_, i) => ns[0] + i));
  });

  test("the writer's open append fd still reaches the visible file", () => {
    const p = workerLog(ctx.root);
    writeLog(p, MAX_BYTES * 3);
    // Opened before the trim and held across it, exactly as the worker holds
    // worker.log: this fd names an inode, and a trim that renames a new file into
    // place leaves it writing to one that nothing can open again.
    const fd = openSync(p, "a");
    try {
      runHook(ctx.root);
      writeSync(fd, `${JSON.stringify({ afterTrim: true })}\n`);
    } finally {
      closeSync(fd);
    }
    // Compared as the LAST line rather than searched for in the whole file: a
    // failure here prints one line instead of the half-megabyte that survived.
    const lines = readFileSync(p, "utf-8").split("\n").filter(Boolean);
    expect(lines[lines.length - 1]).toBe('{"afterTrim":true}');
  });

  test("leaves no scratch file behind", () => {
    const p = workerLog(ctx.root);
    writeLog(p, MAX_BYTES * 3);
    runHook(ctx.root);
    const leftovers = spawnSync("bash", ["-c", `ls ${JSON.stringify(join(ctx.root, ".recall"))}`], {
      encoding: "utf-8",
    }).stdout;
    expect(leftovers).not.toContain(".trim");
  });
});
