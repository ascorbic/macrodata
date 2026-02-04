/**
 * Test helpers for macrodata integration tests
 *
 * Provides isolated test environments with temp directories
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
  type: "people" | "projects",
  name: string,
  content: string
) {
  const filePath = join(ctx.entitiesDir, type, `${name}.md`);
  writeFileSync(filePath, content);
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
