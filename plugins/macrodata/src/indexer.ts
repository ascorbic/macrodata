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
import { createHash } from "crypto";
import { embed, embedBatch, preloadModel as preloadEmbeddings } from "./embeddings.js";
import { getIndexDir, getEntitiesDir, getJournalDir } from "./config.js";
import { listJsonlFiles, readJsonlFile, resolveJsonlPath } from "./jsonl.js";

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

// Cached index instance with path tracking
let index: LocalIndex | null = null;
let indexPath: string | null = null;
const INDEX_EMBEDDING_BATCH_SIZE = 96;

function createStableSectionId(type: MemoryItemType, filename: string, sectionTitle: string, occurrence: number): string {
  const digest = createHash("sha1")
    .update(`${filename}::${sectionTitle.toLowerCase()}::${occurrence}`)
    .digest("hex")
    .slice(0, 16);
  return `${type}-${filename}-${digest}`;
}

async function deleteItemsBySource(source: string): Promise<void> {
  const idx = await getIndex();
  const items = await idx.listItems();

  for (const item of items) {
    const metadata = item.metadata as Record<string, unknown>;
    if (metadata.source === source) {
      await idx.deleteItem(item.id);
    }
  }
}

/**
 * Get or create the vector index
 * Re-creates if the configured path has changed
 */
async function getIndex(): Promise<LocalIndex> {
  const currentIndexDir = getIndexDir();
  const currentIndexPath = join(currentIndexDir, "vectors");

  // Invalidate cache if path changed
  if (index && indexPath !== currentIndexPath) {
    index = null;
    indexPath = null;
  }

  if (index) return index;

  // Ensure index directory exists
  if (!existsSync(currentIndexDir)) {
    mkdirSync(currentIndexDir, { recursive: true });
  }

  index = new LocalIndex(currentIndexPath);
  indexPath = currentIndexPath;

  // Create if doesn't exist
  if (!(await index.isIndexCreated())) {
    console.log("[Indexer] Creating new index...");
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

  for (let i = 0; i < items.length; i += INDEX_EMBEDDING_BATCH_SIZE) {
    const chunk = items.slice(i, i + INDEX_EMBEDDING_BATCH_SIZE);
    const vectors = await embedBatch(chunk.map((item) => item.content));

    for (let j = 0; j < chunk.length; j++) {
      const item = chunk[j];
      const metadata: Record<string, string | number | boolean> = {
        type: item.type,
        content: item.content,
        source: item.source,
      };
      if (item.section) metadata.section = item.section;
      if (item.timestamp) metadata.timestamp = item.timestamp;

      await idx.upsertItem({
        id: item.id,
        vector: vectors[j],
        metadata,
      });
    }
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
    console.log("[Indexer] Index is empty");
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
async function parseJournalForIndexing(): Promise<MemoryItem[]> {
  const items: MemoryItem[] = [];
  const journalDir = getJournalDir();

  const files = listJsonlFiles(journalDir);

  for (const file of files) {
    try {
      const stats = await readJsonlFile<{ topic: string; content: string; timestamp?: string }>(
        resolveJsonlPath(journalDir, file),
        {
          onItem(entry, lineNumber) {
            items.push({
              id: `journal-${file}-${lineNumber - 1}`,
              type: "journal",
              content: `[${entry.topic}] ${entry.content}`,
              source: file,
              timestamp: entry.timestamp,
            });
          },
        }
      );

      if (stats.malformedLines > 0) {
        console.warn(`[Indexer] Skipped ${stats.malformedLines} malformed line(s) in journal file ${file}`);
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
  const dir = join(getEntitiesDir(), subdir);

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
      const titleOccurrences = new Map<string, number>();
      for (let i = 1; i < sections.length; i++) {
        const section = sections[i];
        const firstLine = section.split("\n")[0];
        const sectionTitle = firstLine.trim();
        const sectionContent = section.slice(firstLine.length).trim();

        if (sectionContent) {
          const normalizedTitle = sectionTitle.toLowerCase();
          const occurrence = (titleOccurrences.get(normalizedTitle) ?? 0) + 1;
          titleOccurrences.set(normalizedTitle, occurrence);

          items.push({
            id: createStableSectionId(type, filename, sectionTitle, occurrence),
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
  console.log("[Indexer] Starting full index rebuild...");
  const startTime = Date.now();

  const allItems: MemoryItem[] = [];

  // 1. Index journal entries
  console.log("[Indexer] Parsing journal...");
  allItems.push(...(await parseJournalForIndexing()));

  // 2. Index people
  console.log("[Indexer] Parsing people...");
  allItems.push(...parseEntitiesForIndexing("people", "person"));

  // 3. Index projects
  console.log("[Indexer] Parsing projects...");
  allItems.push(...parseEntitiesForIndexing("projects", "project"));

  const idx = await getIndex();
  if (await idx.isIndexCreated()) {
    await idx.deleteIndex();
  }
  await idx.createIndex();

  // Index all items
  console.log(`[Indexer] Indexing ${allItems.length} items...`);
  await indexItems(allItems);

  const duration = Date.now() - startTime;
  console.log(`[Indexer] Index rebuild complete in ${duration}ms`);

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
    const source = `${subdir}/${basename(filePath)}`;

    // Split by ## headers for section-level indexing
    const sections = content.split(/^## /m);

    // Preamble (before any ##)
    if (sections[0].trim()) {
      items.push({
        id: `${type}-${filename}-preamble`,
        type,
        content: sections[0].trim(),
        source,
        section: "preamble",
      });
    }

    // Each section
    const titleOccurrences = new Map<string, number>();
    for (let i = 1; i < sections.length; i++) {
      const section = sections[i];
      const firstLine = section.split("\n")[0];
      const sectionTitle = firstLine.trim();
      const sectionContent = section.slice(firstLine.length).trim();

      if (sectionContent) {
        const normalizedTitle = sectionTitle.toLowerCase();
        const occurrence = (titleOccurrences.get(normalizedTitle) ?? 0) + 1;
        titleOccurrences.set(normalizedTitle, occurrence);

        items.push({
          id: createStableSectionId(type, filename, sectionTitle, occurrence),
          type,
          content: `## ${sectionTitle}\n\n${sectionContent}`,
          source,
          section: sectionTitle,
        });
      }
    }

    await deleteItemsBySource(source);
    await indexItems(items);
    console.log(`[Indexer] Indexed ${items.length} sections from ${basename(filePath)}`);
  } catch (err) {
    console.error(`[Indexer] Failed to index ${filePath}: ${String(err)}`);
  }
}

/**
 * Preload the embedding model (call during startup)
 */
export async function preloadModel(): Promise<void> {
  await preloadEmbeddings();
}
