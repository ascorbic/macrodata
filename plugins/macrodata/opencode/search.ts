/**
 * Semantic search for OpenCode plugin
 *
 * Uses Vectra for vector search, with embeddings from src/embeddings.ts
 * (local Transformers.js by default, remote provider when configured).
 */

import { LocalIndex } from "vectra";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { embed, embedBatch, embedQuery } from "../src/embeddings.js";
import { getStateRoot } from "./context.js";
import { logger } from "./logger.js";

// Memory index singleton
let memoryIndex: LocalIndex | null = null;

async function getMemoryIndex(): Promise<LocalIndex> {
  if (memoryIndex) return memoryIndex;

  const stateRoot = getStateRoot();
  const indexPath = join(stateRoot, ".index", "vectors");

  const indexDir = join(stateRoot, ".index");
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true });
  }

  memoryIndex = new LocalIndex(indexPath);

  if (!(await memoryIndex.isIndexCreated())) {
    logger.log("Creating new memory index...");
    await memoryIndex.createIndex();
  }

  return memoryIndex;
}

export type MemoryItemType = "journal" | "person" | "project" | "topic";

export interface SearchResult {
  content: string;
  source: string;
  section?: string;
  timestamp?: string;
  type: MemoryItemType;
  score: number;
}

/**
 * Search memory index
 */
export async function searchMemory(
  query: string,
  options: {
    limit?: number;
    type?: MemoryItemType;
    since?: string;
  } = {}
): Promise<SearchResult[]> {
  const { limit = 5, type, since } = options;

  const idx = await getMemoryIndex();
  const stats = await idx.listItems();

  if (stats.length === 0) {
    return [];
  }

  const queryVector = await embedQuery(query);
  const results = await idx.queryItems(queryVector, limit * 2);

  let filtered = results;
  if (type || since) {
    filtered = results.filter((item) => {
      const meta = item.item.metadata as Record<string, unknown>;
      if (type && meta.type !== type) return false;
      if (since && meta.timestamp && (meta.timestamp as string) < since) return false;
      return true;
    });
  }

  return filtered.slice(0, limit).map((r) => {
    const meta = r.item.metadata as Record<string, unknown>;
    return {
      content: meta.content as string,
      source: meta.source as string,
      section: meta.section as string | undefined,
      timestamp: meta.timestamp as string | undefined,
      type: meta.type as MemoryItemType,
      score: r.score,
    };
  });
}

/**
 * Rebuild memory index from journal and entity files
 */
export async function rebuildMemoryIndex(): Promise<{ itemCount: number }> {
  logger.log("Rebuilding memory index...");
  const startTime = Date.now();
  const stateRoot = getStateRoot();

  interface MemoryItem {
    id: string;
    type: MemoryItemType;
    content: string;
    source: string;
    section?: string;
    timestamp?: string;
  }

  const allItems: MemoryItem[] = [];

  // Index journal entries
  const journalDir = join(stateRoot, "journal");
  if (existsSync(journalDir)) {
    const files = readdirSync(journalDir).filter((f) => f.endsWith(".jsonl"));
    for (const file of files) {
      try {
        const content = readFileSync(join(journalDir, file), "utf-8");
        const lines = content.trim().split("\n").filter(Boolean);
        for (let i = 0; i < lines.length; i++) {
          try {
            const entry = JSON.parse(lines[i]);
            allItems.push({
              id: `journal-${file}-${i}`,
              type: "journal",
              content: `[${entry.topic}] ${entry.content}`,
              source: file,
              timestamp: entry.timestamp,
            });
          } catch {
            // Skip malformed lines
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Index entity files (people, projects)
  const entitiesDir = join(stateRoot, "entities");
  for (const [subdir, type] of [
    ["people", "person"],
    ["projects", "project"],
  ] as const) {
    const dir = join(entitiesDir, subdir);
    if (!existsSync(dir)) continue;

    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const content = readFileSync(join(dir, file), "utf-8");
        const filename = file.replace(".md", "");

        // Split by ## headers
        const sections = content.split(/^## /m);

        if (sections[0].trim()) {
          allItems.push({
            id: `${type}-${filename}-preamble`,
            type,
            content: sections[0].trim(),
            source: `${subdir}/${file}`,
            section: "preamble",
          });
        }

        for (let i = 1; i < sections.length; i++) {
          const section = sections[i];
          const firstLine = section.split("\n")[0];
          const sectionTitle = firstLine.trim();
          const sectionContent = section.slice(firstLine.length).trim();

          if (sectionContent) {
            allItems.push({
              id: `${type}-${filename}-${i}`,
              type,
              content: `## ${sectionTitle}\n\n${sectionContent}`,
              source: `${subdir}/${file}`,
              section: sectionTitle,
            });
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Index topics
  const topicsDir = join(stateRoot, "topics");
  if (existsSync(topicsDir)) {
    const files = readdirSync(topicsDir).filter((f) => f.endsWith(".md"));
    for (const file of files) {
      try {
        const content = readFileSync(join(topicsDir, file), "utf-8");
        const filename = file.replace(".md", "");
        allItems.push({
          id: `topic-${filename}`,
          type: "topic",
          content: content.trim(),
          source: `topics/${file}`,
        });
      } catch {
        // Skip
      }
    }
  }

  if (allItems.length === 0) {
    return { itemCount: 0 };
  }

  // Generate embeddings
  logger.log(`Generating embeddings for ${allItems.length} items...`);
  const vectors = await embedBatch(allItems.map((i) => i.content));

  // Index all items in a single update transaction (one index.json write)
  const idx = await getMemoryIndex();
  await idx.beginUpdate();
  try {
    for (let i = 0; i < allItems.length; i++) {
      const item = allItems[i];
      const metadata: Record<string, string | number | boolean> = {
        type: item.type,
        content: item.content,
        source: item.source,
      };
      if (item.section) metadata.section = item.section;
      if (item.timestamp) metadata.timestamp = item.timestamp;

      await idx.upsertItem({
        id: item.id,
        vector: vectors[i],
        metadata,
      });
    }
    await idx.endUpdate();
  } catch (err) {
    idx.cancelUpdate();
    throw err;
  }

  const duration = Date.now() - startTime;
  logger.log(`Index rebuilt in ${duration}ms`);

  return { itemCount: allItems.length };
}

/**
 * Get memory index stats
 */
export async function getMemoryIndexStats(): Promise<{ itemCount: number }> {
  const idx = await getMemoryIndex();
  const items = await idx.listItems();
  return { itemCount: items.length };
}

/**
 * Index a single journal entry (incremental)
 */
export async function indexJournalEntry(entry: {
  timestamp: string;
  topic: string;
  content: string;
}): Promise<void> {
  const idx = await getMemoryIndex();
  const vector = await embed(`[${entry.topic}] ${entry.content}`);

  await idx.upsertItem({
    id: `journal-${entry.timestamp}`,
    vector,
    metadata: {
      type: "journal",
      content: `[${entry.topic}] ${entry.content}`,
      source: "journal",
      timestamp: entry.timestamp,
    },
  });
}
