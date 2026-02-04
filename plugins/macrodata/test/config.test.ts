/**
 * Integration tests for config module
 *
 * Tests that MACRODATA_ROOT env var properly controls all paths
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createTestContext, type TestContext } from "./helpers";
import { getStateRoot, getStateDir, getEntitiesDir, getJournalDir, getIndexDir, getRemindersDir } from "../src/config";

describe("config", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  test("getStateRoot returns MACRODATA_ROOT env var", () => {
    expect(getStateRoot()).toBe(ctx.root);
  });

  test("getStateDir returns state subdirectory", () => {
    expect(getStateDir()).toBe(ctx.stateDir);
  });

  test("getEntitiesDir returns entities subdirectory", () => {
    expect(getEntitiesDir()).toBe(ctx.entitiesDir);
  });

  test("getJournalDir returns journal subdirectory", () => {
    expect(getJournalDir()).toBe(ctx.journalDir);
  });

  test("getIndexDir returns .index subdirectory", () => {
    expect(getIndexDir()).toBe(ctx.indexDir);
  });

  test("getRemindersDir returns reminders subdirectory", () => {
    expect(getRemindersDir()).toBe(ctx.remindersDir);
  });

  test("paths update when MACRODATA_ROOT changes", () => {
    const originalRoot = ctx.root;

    // Create a second test context (with different root)
    const ctx2 = createTestContext("macrodata-test-2-");

    // Now getStateRoot should return the new root
    expect(getStateRoot()).toBe(ctx2.root);
    expect(getStateRoot()).not.toBe(originalRoot);

    ctx2.cleanup();

    // Restore original context
    process.env.MACRODATA_ROOT = originalRoot;
    expect(getStateRoot()).toBe(originalRoot);
  });
});
