/**
 * Memory Indexer
 *
 * Manages the vector index for semantic search over:
 * - Journal entries
 * - People files
 * - Project files
 *
 * Uses Vectra for storage and embeddings.ts for vector generation.
 */

import { LocalIndex } from "vectra";
import { join, basename } from "path";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { embed, embedBatch, preloadModel as preloadEmbeddings } from "./embeddings.js";
import { homedir } from "os";

// Configuration
const STATE_ROOT = process.env.MACRODATA_ROOT || join(homedir(), ".config", "macrodata");
const INDEX_PATH = join(STATE_ROOT, ".index", "vectors");
const ENTITIES_DIR = join(STATE_ROOT, "entities");
const JOURNAL_DIR = join(STATE_ROOT, "journal");

// Item types for filtering
export type MemoryItemType = "journal" | "person" | "project";

export interface MemoryItem {
  id: string;
  type: MemoryItemType;
  content: string;
  source: string;
  section?: string;
  timestamp?: string;
}

export interface SearchResult {
  content: string;
  source: string;
  section?: string;
  timestamp?: string;
  type: MemoryItemType;
  score: number;
}

// Singleton index instance
let index: LocalIndex | null = null;

/**
 * Get or create the vector index
 */
async function getIndex(): Promise<LocalIndex> {
  if (index) return index;

  // Ensure index directory exists
  const indexDir = join(STATE_ROOT, ".index");
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true });
  }

  index = new LocalIndex(INDEX_PATH);

  // Create if doesn't exist
  if (!(await index.isIndexCreated())) {
    console.error("[Indexer] Creating new index...");
    await index.createIndex();
  }

  return index;
}

/**
 * Add or update a single item in the index
 */
export async function indexItem(item: MemoryItem): Promise<void> {
  const idx = await getIndex();
  const vector = await embed(item.content);

  const metadata: Record<string, string | number | boolean> = {
    type: item.type,
    content: item.content,
    source: item.source,
  };
  if (item.section) metadata.section = item.section;
  if (item.timestamp) metadata.timestamp = item.timestamp;

  await idx.upsertItem({
    id: item.id,
    vector,
    metadata,
  });
}

/**
 * Add or update multiple items (batched for efficiency)
 */
export async function indexItems(items: MemoryItem[]): Promise<void> {
  if (items.length === 0) return;

  const idx = await getIndex();
  const vectors = await embedBatch(items.map((i) => i.content));

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
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
}

/**
 * Search the index
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
  const idx = await getIndex();

  // Check if index has items
  const stats = await idx.listItems();
  if (stats.length === 0) {
    console.error("[Indexer] Index is empty");
    return [];
  }

  const queryVector = await embed(query);
  const results = await idx.queryItems(queryVector, limit * 2);

  // Filter results if type or since specified
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
 * Parse journal files and return items for indexing
 */
function parseJournalForIndexing(): MemoryItem[] {
  const items: MemoryItem[] = [];

  if (!existsSync(JOURNAL_DIR)) return items;

  const files = readdirSync(JOURNAL_DIR).filter((f) => f.endsWith(".jsonl"));

  for (const file of files) {
    try {
      const content = readFileSync(join(JOURNAL_DIR, file), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          items.push({
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

  return items;
}

/**
 * Parse entity files (people, projects) for indexing
 */
function parseEntitiesForIndexing(subdir: "people" | "projects", type: MemoryItemType): MemoryItem[] {
  const items: MemoryItem[] = [];
  const dir = join(ENTITIES_DIR, subdir);

  if (!existsSync(dir)) return items;

  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));

  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const filename = file.replace(".md", "");

      // Split by ## headers for section-level indexing
      const sections = content.split(/^## /m);

      // Preamble (before any ##)
      if (sections[0].trim()) {
        items.push({
          id: `${type}-${filename}-preamble`,
          type,
          content: sections[0].trim(),
          source: `${subdir}/${file}`,
          section: "preamble",
        });
      }

      // Each section
      for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const firstLine = section.split("\n")[0];
        const sectionTitle = firstLine.trim();
        const sectionContent = section.slice(firstLine.length).trim();

        if (sectionContent) {
          items.push({
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

  return items;
}

/**
 * Rebuild the entire index from scratch
 */
export async function rebuildIndex(): Promise<{ itemCount: number }> {
  console.error("[Indexer] Starting full index rebuild...");
  const startTime = Date.now();

  const allItems: MemoryItem[] = [];

  // 1. Index journal entries
  console.error("[Indexer] Parsing journal...");
  allItems.push(...parseJournalForIndexing());

  // 2. Index people
  console.error("[Indexer] Parsing people...");
  allItems.push(...parseEntitiesForIndexing("people", "person"));

  // 3. Index projects
  console.error("[Indexer] Parsing projects...");
  allItems.push(...parseEntitiesForIndexing("projects", "project"));

  // Index all items
  console.error(`[Indexer] Indexing ${allItems.length} items...`);
  await indexItems(allItems);

  const duration = Date.now() - startTime;
  console.error(`[Indexer] Index rebuild complete in ${duration}ms`);

  return { itemCount: allItems.length };
}

/**
 * Index a single journal entry (for incremental updates)
 */
export async function indexJournalEntry(entry: {
  timestamp: string;
  topic: string;
  content: string;
}): Promise<void> {
  const item: MemoryItem = {
    id: `journal-${entry.timestamp}`,
    type: "journal",
    content: `[${entry.topic}] ${entry.content}`,
    source: "journal",
    timestamp: entry.timestamp,
  };
  await indexItem(item);
}

/**
 * Get index stats
 */
export async function getIndexStats(): Promise<{ itemCount: number }> {
  const idx = await getIndex();
  const items = await idx.listItems();
  return { itemCount: items.length };
}

/**
 * Index a single entity file (person or project)
 * Called by daemon when files change
 */
export async function indexEntityFile(filePath: string): Promise<void> {
  const filename = basename(filePath, ".md");
  
  // Determine type from path
  let type: MemoryItemType;
  if (filePath.includes("/people/")) {
    type = "person";
  } else if (filePath.includes("/projects/")) {
    type = "project";
  } else {
    console.error(`[Indexer] Unknown entity type for: ${filePath}`);
    return;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const items: MemoryItem[] = [];
    const subdir = type === "person" ? "people" : "projects";

    // Split by ## headers for section-level indexing
    const sections = content.split(/^## /m);

    // Preamble (before any ##)
    if (sections[0].trim()) {
      items.push({
        id: `${type}-${filename}-preamble`,
        type,
        content: sections[0].trim(),
        source: `${subdir}/${basename(filePath)}`,
        section: "preamble",
      });
    }

    // Each section
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];
      const firstLine = section.split("\n")[0];
      const sectionTitle = firstLine.trim();
      const sectionContent = section.slice(firstLine.length).trim();

      if (sectionContent) {
        items.push({
          id: `${type}-${filename}-${i}`,
          type,
          content: `## ${sectionTitle}\n\n${sectionContent}`,
          source: `${subdir}/${basename(filePath)}`,
          section: sectionTitle,
        });
      }
    }

    await indexItems(items);
    console.error(`[Indexer] Indexed ${items.length} sections from ${basename(filePath)}`);
  } catch (err) {
    console.error(`[Indexer] Failed to index ${filePath}: ${err}`);
  }
}

/**
 * Preload the embedding model (call during startup)
 */
export async function preloadModel(): Promise<void> {
  await preloadEmbeddings();
}
