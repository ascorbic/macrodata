/**
 * Black-box tests for the dependency bootstrap hook (ensure-deps.sh)
 *
 * `bun` is stubbed on PATH so the suite stays offline: the stub records its cwd
 * and argv, prints noise on stdout (the hook must not leak it into the model's
 * context), and creates a node_modules dir. Tests assert the contract, not the
 * install.
 */

import { spawnSync } from "child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const SCRIPT = join(dirname(import.meta.dir), "bin", "ensure-deps.sh");

const PACKAGE_JSON = JSON.stringify({ name: "fixture", dependencies: { left_pad: "1.0.0" } });
const LOCKFILE = '{ "lockfileVersion": 1 }';
const BUN_STDOUT_NOISE = "stub-bun-progress-noise";

let base: string;
let pluginRoot: string;
let dataDir: string;
let stubDir: string;
let bunLog: string;
let failMarker: string;

function writeManifests(dir: string, pkg = PACKAGE_JSON, lock = LOCKFILE) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), pkg);
  writeFileSync(join(dir, "bun.lock"), lock);
}

/** Each line is "<cwd>|<argv>" for one stub invocation. */
function bunInvocations(): string[] {
  if (!existsSync(bunLog)) return [];
  return readFileSync(bunLog, "utf-8").split("\n").filter(Boolean);
}

function run(opts: { data?: string | null } = {}) {
  const data = opts.data === undefined ? dataDir : opts.data;
  const env: Record<string, string> = {
    PATH: `${stubDir}:${process.env.PATH}`,
    HOME: process.env.HOME ?? base,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
  };
  if (data !== null) env.CLAUDE_PLUGIN_DATA = data;

  return spawnSync(SCRIPT, [], { encoding: "utf-8", env, timeout: 10000 });
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "macrodata-ensure-deps-"));
  pluginRoot = join(base, "plugin-root");
  dataDir = join(base, "data");
  stubDir = join(base, "stub");
  bunLog = join(base, "bun-invocations.log");
  failMarker = join(base, "bun-should-fail");

  writeManifests(pluginRoot);
  mkdirSync(stubDir, { recursive: true });

  const stub = `#!/bin/sh
printf '%s|%s\\n' "$(pwd)" "$*" >> "${bunLog}"
echo "${BUN_STDOUT_NOISE}"
if [ -f "${failMarker}" ]; then
    echo "stub bun: simulated install failure" >&2
    exit 1
fi
mkdir -p node_modules/installed-marker
exit 0
`;
  writeFileSync(join(stubDir, "bun"), stub);
  chmodSync(join(stubDir, "bun"), 0o755);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("ensure-deps.sh", () => {
  test("is executable", () => {
    expect(lstatSync(SCRIPT).mode & 0o111).toBeGreaterThan(0);
  });

  describe("install guard", () => {
    test("installs into the data dir and links it into the plugin root", () => {
      const res = run();

      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");

      const calls = bunInvocations();
      expect(calls.length).toBe(1);
      const [cwd, argv] = (calls[0] as string).split("|");
      expect(realpathSync(cwd as string)).toBe(realpathSync(dataDir));
      expect(argv).toBe("install --frozen-lockfile --production");

      // Working manifests feed the install; the .installed-* stamps are written
      // only after it succeeds and are what the next run diffs against.
      expect(readFileSync(join(dataDir, "package.json"), "utf-8")).toBe(PACKAGE_JSON);
      expect(readFileSync(join(dataDir, "bun.lock"), "utf-8")).toBe(LOCKFILE);
      expect(readFileSync(join(dataDir, ".installed-package.json"), "utf-8")).toBe(PACKAGE_JSON);
      expect(readFileSync(join(dataDir, ".installed-bun.lock"), "utf-8")).toBe(LOCKFILE);

      expect(readlinkSync(join(pluginRoot, "node_modules"))).toBe(join(dataDir, "node_modules"));
      expect(existsSync(join(pluginRoot, "node_modules", "installed-marker"))).toBe(true);
    });

    test("creates the data dir when it does not exist yet", () => {
      rmSync(dataDir, { recursive: true, force: true });

      expect(run().status).toBe(0);
      expect(existsSync(join(dataDir, "package.json"))).toBe(true);
    });

    test("does not run bun when both manifests already match", () => {
      run();
      const res = run();

      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
      expect(bunInvocations().length).toBe(1);
    });

    test("reinstalls when only bun.lock changed", () => {
      run();
      writeFileSync(join(pluginRoot, "bun.lock"), '{ "lockfileVersion": 1, "bumped": true }');

      expect(run().status).toBe(0);
      expect(bunInvocations().length).toBe(2);
      expect(readFileSync(join(dataDir, "bun.lock"), "utf-8")).toContain("bumped");
    });

    test("reinstalls when only package.json changed", () => {
      run();
      writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({ name: "fixture-v2" }));

      expect(run().status).toBe(0);
      expect(bunInvocations().length).toBe(2);
      expect(readFileSync(join(dataDir, "package.json"), "utf-8")).toContain("fixture-v2");
    });

    test("keeps bun's stdout out of the hook's stdout", () => {
      const res = run();

      expect(res.stdout).not.toContain(BUN_STDOUT_NOISE);
      expect(res.stderr).toContain(BUN_STDOUT_NOISE);
    });
  });

  describe("failed install", () => {
    test("drops the stamps, reports on stderr, and exits non-zero", () => {
      writeFileSync(failMarker, "");
      const res = run();

      expect(res.status).not.toBe(0);
      expect(res.stdout).toBe("");
      expect(res.stderr).toContain("dependency install failed");
      expect(existsSync(join(dataDir, ".installed-package.json"))).toBe(false);
      expect(existsSync(join(dataDir, ".installed-bun.lock"))).toBe(false);
    });

    test("an install killed mid-run leaves no stamps, so the next run retries", () => {
      // Simulate a crash rather than a failure: the first run installed and
      // stamped; deleting the stamps reproduces dying between install and
      // stamping, which must read as stale on the next run.
      run();
      rmSync(join(dataDir, ".installed-package.json"));
      rmSync(join(dataDir, ".installed-bun.lock"));

      expect(run().status).toBe(0);
      expect(bunInvocations().length).toBe(2);
    });

    test("retries on the next run instead of treating the failure as up to date", () => {
      writeFileSync(failMarker, "");
      run();
      rmSync(failMarker);

      const res = run();

      expect(res.status).toBe(0);
      expect(bunInvocations().length).toBe(2);
      expect(existsSync(join(dataDir, ".installed-package.json"))).toBe(true);
    });

    test("still links the plugin root so an earlier install stays usable", () => {
      writeFileSync(failMarker, "");
      run();

      expect(readlinkSync(join(pluginRoot, "node_modules"))).toBe(join(dataDir, "node_modules"));
    });
  });

  describe("symlink guard", () => {
    test("links a fresh version dir whose manifests already match (no reinstall)", () => {
      // What a plugin update looks like when deps did not change: the install is
      // current (stamps match), but the new version dir has no symlink yet.
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, ".installed-package.json"), PACKAGE_JSON);
      writeFileSync(join(dataDir, ".installed-bun.lock"), LOCKFILE);
      mkdirSync(join(dataDir, "node_modules"), { recursive: true });

      const res = run();

      expect(res.status).toBe(0);
      expect(bunInvocations()).toEqual([]);
      expect(readlinkSync(join(pluginRoot, "node_modules"))).toBe(join(dataDir, "node_modules"));
    });

    test("repoints a symlink aimed somewhere else", () => {
      const stale = join(base, "stale-modules");
      mkdirSync(stale, { recursive: true });
      symlinkSync(stale, join(pluginRoot, "node_modules"));

      run();

      expect(readlinkSync(join(pluginRoot, "node_modules"))).toBe(join(dataDir, "node_modules"));
    });

    test("leaves a real node_modules directory alone", () => {
      const real = join(pluginRoot, "node_modules");
      mkdirSync(real, { recursive: true });
      writeFileSync(join(real, "dev-install-marker"), "");

      expect(run().status).toBe(0);
      expect(lstatSync(real).isSymbolicLink()).toBe(false);
      expect(existsSync(join(real, "dev-install-marker"))).toBe(true);
    });
  });

  describe("without CLAUDE_PLUGIN_DATA", () => {
    test("exits 0 silently and touches nothing", () => {
      const res = run({ data: null });

      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
      expect(res.stderr).toBe("");
      expect(bunInvocations()).toEqual([]);
      expect(existsSync(join(pluginRoot, "node_modules"))).toBe(false);
    });

    test("exits 0 silently when it is set but empty", () => {
      const res = run({ data: "" });

      expect(res.status).toBe(0);
      expect(res.stdout).toBe("");
      expect(bunInvocations()).toEqual([]);
    });
  });
});
