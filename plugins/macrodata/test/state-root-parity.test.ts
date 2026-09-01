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
 *
 * They also hold the two canonicalizers together. The root is an identity, not
 * only a path — the hook puts it in the worker's argv and later asks "is that
 * worker mine?" by string comparison — so two spellings of one directory are two
 * identities over one mailbox, and the resolvers must fold them identically.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "fs";
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
    // Resolved, because both resolvers now resolve: on macOS the per-test temp
    // dir is handed out under /var, which is a symlink to /private/var, so an
    // unresolved `home` would make every expectation below disagree with both
    // implementations at once.
    home = realpathSync(mkdtempSync(join(tmpdir(), "macrodata-root-parity-")));
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

  test("a trailing slash is stripped rather than carried into the identity", () => {
    const { sh, ts } = bothRoots({ MACRODATA_ROOT: `${home}/` });
    expect(sh).toBe(home);
    expect(ts).toBe(sh);
  });

  test("repeated trailing slashes are stripped", () => {
    const { sh, ts } = bothRoots({ MACRODATA_ROOT: `${home}///` });
    expect(sh).toBe(home);
    expect(ts).toBe(sh);
  });

  test("the filesystem root survives slash-stripping", () => {
    const { sh, ts } = bothRoots({ MACRODATA_ROOT: "/" });
    expect(sh).toBe("/");
    expect(ts).toBe(sh);
  });

  test("a symlinked root resolves to its target", () => {
    mkdirSync(join(home, "real"));
    symlinkSync(join(home, "real"), join(home, "link"));
    const { sh, ts } = bothRoots({ MACRODATA_ROOT: join(home, "link") });
    expect(sh).toBe(join(home, "real"));
    expect(ts).toBe(sh);
  });

  test("a root that does not exist keeps the spelling it was given", () => {
    // Nothing to resolve against, and inventing one would make the resolvers
    // disagree with themselves once the directory is created.
    const { sh, ts } = bothRoots({ MACRODATA_ROOT: join(home, "not-created-yet") });
    expect(sh).toBe(join(home, "not-created-yet"));
    expect(ts).toBe(sh);
  });

  test("the same directory reached two ways resolves to one identity", () => {
    mkdirSync(join(home, "store"));
    symlinkSync(join(home, "store"), join(home, "alias"));
    const direct = bothRoots({ MACRODATA_ROOT: join(home, "store") });
    const viaAlias = bothRoots({ MACRODATA_ROOT: `${join(home, "alias")}/` });
    expect(viaAlias.sh).toBe(direct.sh);
    expect(viaAlias.ts).toBe(direct.ts);
    expect(direct.ts).toBe(direct.sh);
  });

  // A control character in the root is not merely an odd path: `ps` renders a
  // newline as `\012`, and the hook finds its own worker by matching the root
  // against that rendering. It never matches again, so every prompt starts a
  // worker that the next prompt cannot see — an unbounded spawn loop, from an
  // env var with a stray newline.
  for (const [label, value] of [
    ["a newline", "\n"],
    ["a tab", "\t"],
  ] as const) {
    test(`a root containing ${label} falls back to the default`, () => {
      const { sh, ts } = bothRoots({ MACRODATA_ROOT: `${home}/bad${value}name` });
      expect(sh).toBe(join(home, ".config", "macrodata"));
      expect(ts).toBe(sh);
    });
  }

  // A NUL cannot travel through the environment — execve rejects it — but it can
  // sit in config.json, and there it is the one control character the shell does
  // not merely mishandle: command substitution deletes it (warning on stderr
  // while it does, on bash >= 4.4), leaving the shell with a shorter path than
  // getStateRoot() sees and the user with a squeak every prompt.
  test("a config root containing a NUL falls back to the default", () => {
    writeConfig(`{ "root": "${home}/bad\u0000name" }`);
    const { sh, ts } = bothRoots();
    expect(sh).toBe(join(home, ".config", "macrodata"));
    expect(ts).toBe(sh);
  });

  test("a config root is canonicalized too, not just the env one", () => {
    mkdirSync(join(home, "store"));
    symlinkSync(join(home, "store"), join(home, "alias"));
    writeConfig(JSON.stringify({ root: `${join(home, "alias")}/` }));
    const { sh, ts } = bothRoots();
    expect(sh).toBe(join(home, "store"));
    expect(ts).toBe(sh);
  });

  test("an unusable env root does not fall through to the config file", () => {
    // The env rung is a decision, not a suggestion: an operator who exported a
    // broken MACRODATA_ROOT gets the default, not silently whatever config.json
    // happens to say — otherwise the two resolvers must also agree on which of
    // two roots to silently prefer.
    writeConfig(JSON.stringify({ root: join(home, "from-config") }));
    const { sh, ts } = bothRoots({ MACRODATA_ROOT: `${home}/bad\nname` });
    expect(sh).toBe(join(home, ".config", "macrodata"));
    expect(ts).toBe(sh);
  });

  // A root that isn't a string is the rung where the two resolvers diverge for
  // free: `jq -r` renders any JSON value as text, so shell would take `123` as a
  // path, while TypeScript hands the same value to join() and throws — a hook
  // crash on one side and a wrong root on the other, from one typo.
  for (const [label, value] of [
    ["a number", 123],
    ["a boolean", true],
    ["an object", { path: "/nope" }],
    ["an array", ["/nope"]],
    ["null", null],
  ] as const) {
    test(`a root that is ${label} falls back`, () => {
      writeConfig(JSON.stringify({ root: value }));
      const { sh, ts } = bothRoots();
      expect(sh).toBe(join(home, ".config", "macrodata"));
      expect(ts).toBe(sh);
    });
  }
});
