/**
 * Integration test: the FULL SessionStart output.
 *
 * Builds a complete mock macrodata store, then runs every SessionStart hook in
 * the exact order they're registered in plugin.json (substituting
 * ${CLAUDE_PLUGIN_ROOT}), and snapshots the concatenated output — the
 * test-suite equivalent of the /tmp full-output dumps. Because it drives the
 * hooks off plugin.json, it also fails if a hook is removed, reordered,
 * renamed, or starts emitting unexpected content.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addReminder,
  addEntityFile,
  type TestContext,
} from "./helpers";

const PLUGIN_ROOT = dirname(import.meta.dir); // .../plugins/macrodata
const PLUGIN_JSON = join(PLUGIN_ROOT, ".claude-plugin", "plugin.json");

// SessionStart hook commands in registration order, ${CLAUDE_PLUGIN_ROOT} resolved.
function sessionStartCommands(): string[] {
  const plugin = JSON.parse(readFileSync(PLUGIN_JSON, "utf8"));
  return (plugin.hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>).flatMap(
    (group) => group.hooks.map((h) => h.command.replaceAll("${CLAUDE_PLUGIN_ROOT}", PLUGIN_ROOT)),
  );
}

// Run every SessionStart hook against the mock store, in registration order,
// and concatenate the non-empty outputs. This mirrors how Claude Code assembles
// SessionStart context (verified against the hooks docs): each hook's stdout is
// "passed to Claude together" with no delimiter, and a hook that writes nothing
// contributes nothing ("anything you write to stdout is added" — write nothing,
// add nothing). So macrodata-hook.sh session-start (silent when configured)
// correctly drops out.
//
// The asserted-faithful parts are each hook's CONTENT, their ORDER, and the
// empty-drop. The join character is a representation choice: CC documents no
// delimiter, but its exact inter-hook framing is harness-internal/version-
// specific and not ours to reproduce, so we use a single "\n" for readable,
// deterministic snapshots. TZ is pinned so journal timestamps are stable.
function runAllSessionStartHooks(ctx: TestContext): string {
  return sessionStartCommands()
    .map((cmd) => {
      try {
        return execSync(cmd, {
          encoding: "utf8",
          timeout: 15000,
          env: { ...process.env, MACRODATA_ROOT: ctx.root, TZ: "UTC" },
        }).trim();
      } catch (e: unknown) {
        return ((e as { stdout?: string }).stdout ?? "").trim();
      }
    })
    .filter((out) => out.length > 0)
    .join("\n");
}

describe("SessionStart integration", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    // A complete, deterministic mock store.
    setupMinimalState(ctx); // identity/today/human/workspace
    addJournalEntry(ctx, "release", "shipped the sharded SessionStart hooks", new Date("2026-05-29T15:00:00Z"));
    addJournalEntry(ctx, "note", "per-file hooks each get their own 10K envelope", new Date("2026-05-29T14:00:00Z"));
    addReminder(ctx, "morning", {
      type: "cron",
      expression: "0 9 * * *",
      description: "morning prep",
      payload: "noop",
    });
    addEntityFile(
      ctx,
      "projects",
      "billing-api",
      "---\ndescription: REST API service — auth, billing, webhooks\n---\n\n# billing-api\n",
    );
    addEntityFile(ctx, "people", "jordan", "# Jordan\n\nbackend lead"); // no description → footer nudge
  });

  afterEach(() => {
    // macrodata-hook.sh session-start starts a daemon; kill it.
    const pidFile = join(ctx.root, ".daemon.pid");
    if (existsSync(pidFile)) {
      try {
        execSync(`kill ${readFileSync(pidFile, "utf-8").trim()} 2>/dev/null || true`);
      } catch {
        // ignore
      }
    }
    // recall-supervisor.sh starts a worker, which has no pidfile — find it the
    // way the supervisor does, by the sentinel + root in its argv. Scoped to
    // this test's root, so it can never reach a worker serving a real store.
    try {
      execSync(`pkill -f -- "--macrodata-recall-worker ${ctx.root}" 2>/dev/null || true`);
    } catch {
      // ignore
    }
    ctx.cleanup();
  });

  test("full SessionStart output across all hooks (mock store)", () => {
    const output = runAllSessionStartHooks(ctx).replaceAll(ctx.root, "<ROOT>");
    expect(output).toMatchSnapshot();
  });
});
