/**
 * Integration tests for hook script
 *
 * Tests the shell script that integrates with Claude Code
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addReminder,
  type TestContext,
} from "./helpers";

// Get the hook script path
const HOOK_SCRIPT = join(dirname(import.meta.dir), "bin", "macrodata-hook.sh");

function runHook(ctx: TestContext, command: "session-start" | "prompt-submit"): string {
  try {
    return execSync(`MACRODATA_ROOT="${ctx.root}" bash "${HOOK_SCRIPT}" ${command}`, {
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, MACRODATA_ROOT: ctx.root },
    });
  } catch (err: unknown) {
    // Hook might fail if daemon can't start, but we still get output
    const error = err as { stdout?: string; stderr?: string };
    return error.stdout || "";
  }
}

describe("hook script", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    setupMinimalState(ctx);
  });

  afterEach(() => {
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
    test("outputs macrodata context wrapper", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata>");
      expect(output).toContain("</macrodata>");
    });

    test("includes identity section", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-identity>");
      expect(output).toContain("Test Identity");
      expect(output).toContain("</macrodata-identity>");
    });

    test("includes today section", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-today>");
      expect(output).toContain("Running integration tests");
      expect(output).toContain("</macrodata-today>");
    });

    test("includes human section", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-human>");
      expect(output).toContain("Test user");
      expect(output).toContain("</macrodata-human>");
    });

    test("includes workspace section", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-workspace>");
      expect(output).toContain("Integration testing");
      expect(output).toContain("</macrodata-workspace>");
    });

    test("includes journal entries", () => {
      addJournalEntry(ctx, "test-topic", "A journal entry for testing");

      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-journal>");
      expect(output).toContain("test-topic");
    });

    test("includes schedules section", () => {
      addReminder(ctx, "test-schedule", {
        type: "cron",
        expression: "0 9 * * *",
        description: "Morning check",
        payload: "Check stuff",
      });

      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-schedules>");
      expect(output).toContain("Morning check");
    });

    test("includes files listing", () => {
      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-files");
      expect(output).toContain(`root="${ctx.root}"`);
      expect(output).toContain("state/identity.md");
    });

    test("writes context file", () => {
      runHook(ctx, "session-start");
      const contextFile = join(ctx.root, ".claude-context.md");
      expect(existsSync(contextFile)).toBe(true);

      const content = readFileSync(contextFile, "utf-8");
      expect(content).toContain("<macrodata>");
    });

    test("stores lastmod file", () => {
      runHook(ctx, "session-start");
      const lastmodFile = join(ctx.root, ".context-lastmod.json");
      expect(existsSync(lastmodFile)).toBe(true);

      const content = JSON.parse(readFileSync(lastmodFile, "utf-8"));
      expect(content).toHaveProperty("identity");
      expect(content).toHaveProperty("today");
    });
  });

  describe("first-run detection", () => {
    test("shows first-run message when no identity file", () => {
      // Remove identity file
      const identityFile = join(ctx.stateDir, "identity.md");
      if (existsSync(identityFile)) {
        require("fs").unlinkSync(identityFile);
      }

      const output = runHook(ctx, "session-start");
      expect(output).toContain("<macrodata-first-run");
      expect(output).toContain("/onboarding");
    });
  });

  describe("prompt-submit", () => {
    test("injects pending context", () => {
      // Write some pending context
      const pendingFile = join(ctx.root, ".pending-context");
      writeFileSync(pendingFile, "<macrodata-update>Test update</macrodata-update>\n");

      const output = runHook(ctx, "prompt-submit");
      expect(output).toContain("Test update");

      // Pending file should be cleared
      const remaining = existsSync(pendingFile)
        ? readFileSync(pendingFile, "utf-8")
        : "";
      expect(remaining).toBe("");
    });

    test("re-injects context when files change", () => {
      // First session-start to establish baseline
      runHook(ctx, "session-start");

      // Modify a state file
      const todayFile = join(ctx.stateDir, "today.md");
      writeFileSync(todayFile, "# Today\n\n## Now\n\nModified content for testing.\n");

      // Give filesystem a moment
      execSync("sleep 0.1");

      // prompt-submit should detect change and re-inject
      const output = runHook(ctx, "prompt-submit");
      expect(output).toContain("Modified content for testing");
    });
  });
});
