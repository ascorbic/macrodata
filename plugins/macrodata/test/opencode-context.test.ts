/**
 * Tests for OpenCode context injection caching behaviour
 *
 * The system prompt must be byte-stable for the lifetime of a session so it
 * stays in the provider's cached prefix. Volatile content (daemon deltas)
 * goes into user messages instead.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  type TestContext,
} from "./helpers.js";
import {
  formatContextForPrompt,
  getSessionContext,
  buildContextPart,
} from "../opencode/context.js";

let ctx: TestContext;

beforeEach(() => {
  ctx = createTestContext("macrodata-oc-test-");
  setupMinimalState(ctx);
});

afterEach(() => {
  ctx.cleanup();
});

describe("formatContextForPrompt", () => {
  test("formats journal dates as ISO dates, independent of locale", async () => {
    addJournalEntry(ctx, "test", "a journal entry", new Date("2026-01-15T10:30:00Z"));

    const context = await formatContextForPrompt();

    expect(context).toContain("(2026-01-15)");
  });

  test("marks invalid timestamps as unknown", async () => {
    const journalPath = join(ctx.journalDir, "2026-01-15.jsonl");
    writeFileSync(
      journalPath,
      JSON.stringify({ timestamp: "not-a-date", topic: "test", content: "bad clock" }) + "\n"
    );

    const context = await formatContextForPrompt();

    expect(context).toContain("(unknown)");
  });
});

describe("getSessionContext", () => {
  test("returns identical bytes for the same session even after state changes", async () => {
    const first = await getSessionContext("session-stable");
    addJournalEntry(ctx, "test", "logged mid-session");
    writeFileSync(join(ctx.stateDir, "today.md"), "# Today\n\nChanged mid-session.\n");
    const second = await getSessionContext("session-stable");

    expect(second).toBe(first);
  });

  test("reflects current state for a new session", async () => {
    const first = await getSessionContext("session-a");
    addJournalEntry(ctx, "test", "a distinctive new entry");
    const second = await getSessionContext("session-b");

    expect(second).not.toBe(first);
    expect(second).toContain("a distinctive new entry");
  });

  test("computes fresh context when no session ID is available", async () => {
    const first = await getSessionContext(undefined);
    addJournalEntry(ctx, "test", "another distinctive entry");
    const second = await getSessionContext(undefined);

    expect(second).toContain("another distinctive entry");
    expect(first).not.toContain("another distinctive entry");
  });
});

describe("buildContextPart", () => {
  test("builds a synthetic text part bound to the user message", () => {
    const part = buildContextPart("<macrodata-update>delta</macrodata-update>", {
      id: "msg_123",
      sessionID: "ses_456",
    });

    expect(part).toEqual({
      id: "msg_123-macrodata",
      messageID: "msg_123",
      sessionID: "ses_456",
      type: "text",
      synthetic: true,
      text: "<macrodata-update>delta</macrodata-update>",
    });
  });
});
