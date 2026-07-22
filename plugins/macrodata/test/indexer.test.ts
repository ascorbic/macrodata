/**
 * Integration tests for indexer module
 *
 * Tests semantic search indexing with isolated temp directories
 *
 * These tests exercise the real @huggingface/transformers embedding pipeline
 * (no sharp postinstall build step needed anymore, so no skip guard either —
 * a failure to load the library is a real failure).
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

const indexer = await import("../src/indexer");

describe("indexer", () => {
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

        await indexer.indexJournalEntry(entry);

        const stats = await indexer.getIndexStats();
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

      await indexer.indexJournalEntry(entry);

      // Search for related content
      const results = await indexer.searchMemory("italian food pasta", { limit: 5 });
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

      const result = await indexer.rebuildIndex();
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

      const result = await indexer.rebuildIndex();
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

      await indexer.rebuildIndex();

      const results = await indexer.searchMemory("systems programming rust", {
        limit: 5,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].type).toBe("people");
    });
  });

  describe("searchMemory", () => {
    test("filters by type", async () => {
      addJournalEntry(ctx, "work", "Fixed a bug in the authentication system");
      addEntityFile(ctx, "projects", "auth", "# Auth\n\n## Description\n\nAuthentication service.");

      await indexer.rebuildIndex();

      const journalOnly = await indexer.searchMemory("authentication", {
        type: "journal",
        limit: 5,
      });

      const projectOnly = await indexer.searchMemory("authentication", {
        type: "projects",
        limit: 5,
      });

      // Results should be filtered by type
      for (const result of journalOnly) {
        expect(result.type).toBe("journal");
      }
      for (const result of projectOnly) {
        expect(result.type).toBe("projects");
      }
    });

    test("indexes categories beyond people/projects (topics)", async () => {
      addEntityFile(
        ctx,
        "topics",
        "raft",
        "# Raft\n\n## Summary\n\nRaft is a consensus algorithm for managing a replicated log."
      );
      await indexer.rebuildIndex();
      const results = await indexer.searchMemory("consensus algorithm replicated log", {
        limit: 5,
      });
      // The whole point of the fix: a non-people/projects category is indexed,
      // and its type is the verbatim folder name.
      expect(results.some((r) => r.type === "topics")).toBe(true);
    });

    test("filters by since date", async () => {
      const oldDate = new Date("2024-01-01");
      const newDate = new Date("2025-06-01");

      addJournalEntry(ctx, "old", "Old entry from last year", oldDate);
      addJournalEntry(ctx, "new", "New entry from this year", newDate);

      await indexer.rebuildIndex();

      const results = await indexer.searchMemory("entry", {
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
      const results = await indexer.searchMemory("anything", { limit: 5 });
      expect(results).toEqual([]);
    });
  });

  describe("rerank", () => {
    // These tests load a second model (Xenova/ms-marco-MiniLM-L-6-v2) on
    // first invocation; raise the timeout accordingly. Once loaded, the
    // singleton is reused across cases in this block.
    const RERANK_TIMEOUT = 120000;

    async function seedAdversarialIndex() {
      // Four docs chosen so the bi-encoder favorite (high lexical overlap with
      // "Linux kernel" and "language") and the cross-encoder favorite (the
      // doc that actually answers the question) are likely to differ.
      addJournalEntry(
        ctx,
        "noise-overlap",
        "Linux is a popular open-source operating system kernel widely used in servers and embedded systems",
      );
      addJournalEntry(
        ctx,
        "answer",
        "The Linux kernel is written primarily in C with some assembly language for low-level routines",
      );
      addJournalEntry(
        ctx,
        "unrelated-language",
        "Programming languages like Python and Java are popular for web development",
      );
      addJournalEntry(
        ctx,
        "kernel-no-language",
        "The kernel manages hardware resources and provides system call interfaces to user space",
      );
      await indexer.rebuildIndex();
    }

    test(
      "populates rerankScore and vectorScore and sorts by rerankScore",
      async () => {
        await seedAdversarialIndex();

        const reranked = await indexer.searchMemory(
          "What language is the Linux kernel written in?",
          { limit: 3, rerank: true },
        );

        expect(reranked.length).toBeGreaterThan(0);

        for (const r of reranked) {
          expect(r.rerankScore).toBeDefined();
          expect(r.vectorScore).toBeDefined();
          expect(r.rerankScore).toBeGreaterThanOrEqual(0);
          expect(r.rerankScore).toBeLessThanOrEqual(1);
          expect(r.score).toBe(r.rerankScore!);
        }

        for (let i = 1; i < reranked.length; i++) {
          expect(reranked[i - 1].score).toBeGreaterThanOrEqual(reranked[i].score);
        }
      },
      RERANK_TIMEOUT,
    );

    test(
      "omits rerankScore/vectorScore when rerank is off",
      async () => {
        await seedAdversarialIndex();

        const vectorOnly = await indexer.searchMemory(
          "What language is the Linux kernel written in?",
          { limit: 3 },
        );

        expect(vectorOnly.length).toBeGreaterThan(0);
        for (const r of vectorOnly) {
          expect(r.rerankScore).toBeUndefined();
          expect(r.vectorScore).toBeUndefined();
        }
      },
      RERANK_TIMEOUT,
    );

    test(
      "ranks the answer-bearing doc first after rerank",
      async () => {
        await seedAdversarialIndex();

        const reranked = await indexer.searchMemory(
          "What language is the Linux kernel written in?",
          { limit: 3, rerank: true },
        );

        expect(reranked[0].content).toContain("written primarily in C");
      },
      RERANK_TIMEOUT,
    );
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

      await indexer.indexEntityFile(filePath);

      const stats = await indexer.getIndexStats();
      expect(stats.itemCount).toBeGreaterThan(0);

      const results = await indexer.searchMemory("kubernetes docker", { limit: 5 });
      expect(results.length).toBeGreaterThan(0);
    });
  });
});
