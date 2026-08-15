/**
 * The bash state-root ladder in macrodata-hook.sh vs. getStateRoot().
 *
 * macrodata-hook.sh runs on every prompt, so it resolves the root in bash rather
 * than paying a `bun` start per message — which makes two copies of one precedence
 * rule. A divergence between them is silent exactly where it hurts most: the hook
 * would manage a worker for one root while recall-hook.ts files its requests under
 * another, so recall stops dead with every process still reporting healthy.
 *
 * These hold the shell copy against the TypeScript one on every rung, including
 * the ones easy to get wrong in shell: a config file whose `root` is absent, empty,
 * or unparseable all fall through to the default rather than yielding "".
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const PLUGIN_ROOT = join(import.meta.dir, "..");
const HOOK = join(PLUGIN_ROOT, "bin", "macrodata-hook.sh");
const PRINT_ROOT = join(PLUGIN_ROOT, "bin", "recall-print-root.ts");

let home: string;

/** Both resolvers, run against the same environment. */
function bothRoots(extraEnv: Record<string, string> = {}) {
  // HOME drives the default root in both (bash "$HOME", os.homedir()), and
  // MACRODATA_ROOT is dropped unless a case sets it — the ambient one would
  // short-circuit every rung below the first.
  const env: Record<string, string> = { ...process.env, HOME: home, ...extraEnv } as Record<
    string,
    string
  >;
  if (!("MACRODATA_ROOT" in extraEnv)) delete env.MACRODATA_ROOT;

  const sh = spawnSync("bash", [HOOK, "print-root"], { encoding: "utf-8", env });
  const ts = spawnSync("bun", ["run", PRINT_ROOT], { encoding: "utf-8", env });
  // A resolver that died prints nothing, and two dead resolvers agree on nothing
  // perfectly. Pin the exit status so a crash reads as a crash rather than parity.
  expect({ sh: sh.status, ts: ts.status, err: (sh.stderr ?? "") + (ts.stderr ?? "") }).toEqual({
    sh: 0,
    ts: 0,
    err: "",
  });
  return { sh: (sh.stdout ?? "").trim(), ts: (ts.stdout ?? "").trim() };
}

function writeConfig(contents: string) {
  const dir = join(home, ".config", "macrodata");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), contents);
}

describe("state root: bash ladder matches getStateRoot()", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "macrodata-root-parity-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("MACRODATA_ROOT wins over everything", () => {
    writeConfig(JSON.stringify({ root: "/should/be/ignored" }));
    const { sh, ts } = bothRoots({ MACRODATA_ROOT: "/env/wins" });
    expect(sh).toBe("/env/wins");
    expect(ts).toBe(sh);
  });

  test("config.json root is used when the env is unset", () => {
    writeConfig(JSON.stringify({ root: join(home, "elsewhere") }));
    const { sh, ts } = bothRoots();
    expect(sh).toBe(join(home, "elsewhere"));
    expect(ts).toBe(sh);
  });

  test("no config file falls back to the default dir", () => {
    const { sh, ts } = bothRoots();
    expect(sh).toBe(join(home, ".config", "macrodata"));
    expect(ts).toBe(sh);
  });

  test("a config file with no root key falls back", () => {
    writeConfig(JSON.stringify({ somethingElse: true }));
    const { sh, ts } = bothRoots();
    expect(sh).toBe(join(home, ".config", "macrodata"));
    expect(ts).toBe(sh);
  });

  test("an empty root falls back rather than resolving to nothing", () => {
    writeConfig(JSON.stringify({ root: "" }));
    const { sh, ts } = bothRoots();
    expect(sh).toBe(join(home, ".config", "macrodata"));
    expect(ts).toBe(sh);
  });

  test("unparseable JSON falls back rather than aborting", () => {
    writeConfig("{ this is not json");
    const { sh, ts } = bothRoots();
    expect(sh).toBe(join(home, ".config", "macrodata"));
    expect(ts).toBe(sh);
  });
});
