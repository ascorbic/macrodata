/**
 * Integration tests for indexer module
 *
 * Tests semantic search indexing with isolated temp directories
 *
 * NOTE: These tests require the @xenova/transformers embeddings to work,
 * which depends on sharp being properly built. If sharp isn't available,
 * these tests will be skipped.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createTestContext,
  setupMinimalState,
  addJournalEntry,
  addEntityFile,
  type TestContext,
} from "./helpers";
import { join } from "path";

// Check if embeddings are available by trying to load the pipeline
let embeddingsAvailable = false;
try {
  // Quick check - just see if transformers loads without sharp errors
  await import("@xenova/transformers");
  embeddingsAvailable = true;
} catch {
  console.warn("[Test] Embeddings not available - skipping indexer tests");
}

// Only import indexer if embeddings work
const indexer = embeddingsAvailable ? await import("../src/indexer") : null;

describe.skipIf(!embeddingsAvailable)("indexer", () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    setupMinimalState(ctx);
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe("indexJournalEntry", () => {
    test(
      "indexes a single journal entry",
      async () => {
        const entry = {
          timestamp: new Date().toISOString(),
          topic: "test-topic",
          content: "This is a test journal entry about integration testing",
        };

        await indexer!.indexJournalEntry(entry);

        const stats = await indexer!.getIndexStats();
        expect(stats.itemCount).toBe(1);
      },
      { timeout: 30000 }
    );

    test("indexed entries are searchable", async () => {
      const entry = {
        timestamp: new Date().toISOString(),
        topic: "cooking",
        content: "Made a delicious pasta carbonara with fresh eggs",
      };

      await indexer!.indexJournalEntry(entry);

      // Search for related content
      const results = await indexer!.searchMemory("italian food pasta", { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain("carbonara");
    });
  });

  describe("rebuildIndex", () => {
    test("indexes journal files from disk", async () => {
      // Add some journal entries to disk
      addJournalEntry(ctx, "topic1", "First journal entry about TypeScript");
      addJournalEntry(ctx, "topic2", "Second journal entry about React");
      addJournalEntry(ctx, "topic3", "Third journal entry about testing");

      const result = await indexer!.rebuildIndex();
      expect(result.itemCount).toBeGreaterThanOrEqual(3);
    });

    test("indexes entity files", async () => {
      // Add entity files
      addEntityFile(
        ctx,
        "people",
        "alice",
        `# Alice

## About

Software engineer at Acme Corp.

## Notes

Works on frontend development.
`
      );

      addEntityFile(
        ctx,
        "projects",
        "widget",
        `# Widget Project

## Description

A widget for managing widgets.

## Status

In progress.
`
      );

      const result = await indexer!.rebuildIndex();
      // Should have entity sections (2+ per file due to section splitting)
      expect(result.itemCount).toBeGreaterThanOrEqual(4);
    });

    test("entity files are searchable after rebuild", async () => {
      addEntityFile(
        ctx,
        "people",
        "bob",
        `# Bob

## About

Backend developer specializing in Rust and Go.

## Notes

Loves systems programming and performance optimization.
`
      );

      await indexer!.rebuildIndex();

      const results = await indexer!.searchMemory("systems programming rust", {
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe("person");
    });
  });

  describe("searchMemory", () => {
    test("filters by type", async () => {
      addJournalEntry(ctx, "work", "Fixed a bug in the authentication system");
      addEntityFile(ctx, "projects", "auth", "# Auth\n\n## Description\n\nAuthentication service.");

      await indexer!.rebuildIndex();

      const journalOnly = await indexer!.searchMemory("authentication", {
        type: "journal",
        limit: 5,
      });

      const projectOnly = await indexer!.searchMemory("authentication", {
        type: "project",
        limit: 5,
      });

      // Results should be filtered by type
      for (const result of journalOnly) {
        expect(result.type).toBe("journal");
      }
      for (const result of projectOnly) {
        expect(result.type).toBe("project");
      }
    });

    test("filters by since date", async () => {
      const oldDate = new Date("2024-01-01");
      const newDate = new Date("2025-06-01");

      addJournalEntry(ctx, "old", "Old entry from last year", oldDate);
      addJournalEntry(ctx, "new", "New entry from this year", newDate);

      await indexer!.rebuildIndex();

      const results = await indexer!.searchMemory("entry", {
        since: "2025-01-01",
        limit: 10,
      });

      // Should only get the new entry
      for (const result of results) {
        if (result.timestamp) {
          expect(result.timestamp >= "2025-01-01").toBe(true);
        }
      }
    });

    test("returns empty array for empty index", async () => {
      const results = await indexer!.searchMemory("anything", { limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe("indexEntityFile", () => {
    test("indexes a single entity file", async () => {
      const filePath = join(ctx.entitiesDir, "people", "charlie.md");
      addEntityFile(
        ctx,
        "people",
        "charlie",
        `# Charlie

## Role

DevOps engineer.

## Skills

Kubernetes, Docker, CI/CD pipelines.
`
      );

      await indexer!.indexEntityFile(filePath);

      const stats = await indexer!.getIndexStats();
      expect(stats.itemCount).toBeGreaterThan(0);

      const results = await indexer!.searchMemory("kubernetes docker", { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
