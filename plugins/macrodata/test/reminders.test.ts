/**
 * Integration tests for reminder/schedule functionality
 *
 * Tests schedule file management in isolated temp directories
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";
import {
  createTestContext,
  addReminder,
  type TestContext,
} from "./helpers";
import { getRemindersDir } from "../src/config";

describe("reminders", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe("file-based storage", () => {
    test("reminders are stored as individual JSON files", () => {
      addReminder(ctx, "test-reminder-1", {
        type: "cron",
        expression: "0 9 * * *",
        description: "Daily morning check",
        payload: "Check email and calendar",
      });

      const filePath = join(ctx.remindersDir, "test-reminder-1.json");
      expect(existsSync(filePath)).toBe(true);

      const content = JSON.parse(readFileSync(filePath, "utf-8"));
      expect(content.id).toBe("test-reminder-1");
      expect(content.type).toBe("cron");
      expect(content.expression).toBe("0 9 * * *");
    });

    test("multiple reminders create multiple files", () => {
      addReminder(ctx, "reminder-a", {
        type: "cron",
        expression: "0 */2 * * *",
        description: "Every 2 hours",
        payload: "Check status",
      });

      addReminder(ctx, "reminder-b", {
        type: "once",
        expression: "2026-01-15T10:00:00",
        description: "One-time event",
        payload: "Do something",
      });

      const files = readdirSync(ctx.remindersDir).filter((f) =>
        f.endsWith(".json")
      );
      expect(files.length).toBe(2);
      expect(files).toContain("reminder-a.json");
      expect(files).toContain("reminder-b.json");
    });

    test("reminders directory is isolated per test", () => {
      const remindersDir1 = getRemindersDir();

      addReminder(ctx, "isolated-test", {
        type: "cron",
        expression: "0 0 * * *",
        description: "Test",
        payload: "Test",
      });

      // Create a second context
      const ctx2 = createTestContext("macrodata-test-2-");
      const remindersDir2 = getRemindersDir();

      // Directories should be different
      expect(remindersDir1).not.toBe(remindersDir2);

      // Second context should have empty reminders
      const files2 = readdirSync(remindersDir2).filter((f) =>
        f.endsWith(".json")
      );
      expect(files2.length).toBe(0);

      ctx2.cleanup();

      // Restore original context
      process.env.MACRODATA_ROOT = ctx.root;
    });
  });

  describe("schedule types", () => {
    test("cron schedules have correct structure", () => {
      addReminder(ctx, "cron-test", {
        type: "cron",
        expression: "30 8 * * 1-5",
        description: "Weekday mornings",
        payload: "Start work routine",
        agent: "claude",
      });

      const filePath = join(ctx.remindersDir, "cron-test.json");
      const content = JSON.parse(readFileSync(filePath, "utf-8"));

      expect(content.type).toBe("cron");
      expect(content.expression).toBe("30 8 * * 1-5");
      expect(content.agent).toBe("claude");
      expect(content.createdAt).toBeDefined();
    });

    test("one-shot schedules have correct structure", () => {
      addReminder(ctx, "once-test", {
        type: "once",
        expression: "2026-03-15T14:30:00",
        description: "Doctor appointment",
        payload: "Remind about doctor appointment",
        agent: "opencode",
      });

      const filePath = join(ctx.remindersDir, "once-test.json");
      const content = JSON.parse(readFileSync(filePath, "utf-8"));

      expect(content.type).toBe("once");
      expect(content.expression).toBe("2026-03-15T14:30:00");
      expect(content.agent).toBe("opencode");
    });
  });
});
