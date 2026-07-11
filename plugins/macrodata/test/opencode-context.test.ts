/**
 * Tests for OpenCode context injection caching behaviour
 *
 * The system prompt must be byte-stable for the lifetime of a session so it
 * stays in the provider's cached prefix. Volatile content (daemon deltas)
 * goes into user messages instead.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, rmSync } from "fs";
import { join } from "path";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addReminder,
  type TestContext,
} from "./helpers.js";
import {
  formatContextForPrompt,
  getSessionContext,
  getContextUpdate,
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

describe("getContextUpdate", () => {
  test("returns null for a session with no frozen baseline", async () => {
    addJournalEntry(ctx, "test", "an entry");

    expect(await getContextUpdate("session-no-baseline")).toBeNull();
  });

  test("returns null when nothing changed since the baseline", async () => {
    await getSessionContext("session-unchanged");

    expect(await getContextUpdate("session-unchanged")).toBeNull();
  });

  test("returns only the changed sections, then null until the next change", async () => {
    await getSessionContext("session-delta");

    writeFileSync(join(ctx.stateDir, "today.md"), "# Today\n\nA fresh plan.\n");
    const update = await getContextUpdate("session-delta");

    expect(update).toContain("<macrodata-update>");
    expect(update).toContain("<macrodata-today>");
    expect(update).toContain("A fresh plan.");
    expect(update).not.toContain("<macrodata-identity>");

    expect(await getContextUpdate("session-delta")).toBeNull();

    addReminder(ctx, "check-ci", {
      type: "cron",
      expression: "0 9 * * *",
      description: "Check CI status",
      payload: "check ci",
    });
    const second = await getContextUpdate("session-delta");

    expect(second).toContain("<macrodata-schedules>");
    expect(second).toContain("Check CI status");
    expect(second).not.toContain("<macrodata-today>");
  });

  test("surfaces new journal entries", async () => {
    await getSessionContext("session-journal");

    addJournalEntry(ctx, "test", "logged after the snapshot");
    const update = await getContextUpdate("session-journal");

    expect(update).toContain("<macrodata-journal>");
    expect(update).toContain("logged after the snapshot");
  });

  test("ignores the models section, which is only computed at snapshot time", async () => {
    const client = {
      config: {
        providers: async () => ({
          data: {
            providers: [
              {
                id: "anthropic",
                models: {
                  "claude-fable-5": { capabilities: { toolcall: true } },
                },
              },
            ],
          },
        }),
      },
    };
    const snapshot = await getSessionContext("session-models", { client });

    expect(snapshot).toContain("<macrodata-models>");
    expect(await getContextUpdate("session-models")).toBeNull();
  });

  test("delivers the full context once onboarding completes mid-session", async () => {
    for (const f of ["identity.md", "today.md", "human.md", "workspace.md"]) {
      rmSync(join(ctx.stateDir, f), { force: true });
    }
    const firstRun = await getSessionContext("session-onboarding");
    expect(firstRun).toContain("First Run");

    setupMinimalState(ctx);
    const update = await getContextUpdate("session-onboarding");

    expect(update).toContain("<macrodata-identity>");
    expect(update).toContain("<macrodata-today>");
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
      text: "<system-reminder>\n<macrodata-update>delta</macrodata-update>\n</system-reminder>",
    });
  });
});
