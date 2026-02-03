/**
 * Semantic search for OpenCode plugin
 *
 * Uses Vectra + Transformers.js for local vector search
 */

import { LocalIndex } from "vectra";
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { existsSync, readFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { getStateRoot } from "./context.js";

// Embedding pipeline singleton
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineLoading: Promise<FeatureExtractionPipeline> | null = null;

const EMBEDDING_DIMENSIONS = 384;

async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) return embeddingPipeline;

  if (pipelineLoading) return pipelineLoading;

  console.error("[Macrodata] Loading embedding model (first time only)...");
  pipelineLoading = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true,
  });

  try {
    embeddingPipeline = await pipelineLoading;
    console.error("[Macrodata] Model loaded successfully");
    return embeddingPipeline;
  } finally {
    pipelineLoading = null;
  }
}

async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const pipe = await getEmbeddingPipeline();
  const batchSize = 32;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const outputs = await pipe(batch, { pooling: "mean", normalize: true });

    for (let j = 0; j < batch.length; j++) {
      const start = j * EMBEDDING_DIMENSIONS;
      const end = start + EMBEDDING_DIMENSIONS;
      results.push(Array.from((outputs.data as Float32Array).slice(start, end)));
    }
  }

  return results;
}

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
    console.error("[Macrodata] Creating new memory index...");
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

  const queryVector = await embed(query);
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
  console.error("[Macrodata] Rebuilding memory index...");
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
  console.error(`[Macrodata] Generating embeddings for ${allItems.length} items...`);
  const vectors = await embedBatch(allItems.map((i) => i.content));

  // Index all items
  const idx = await getMemoryIndex();
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

  const duration = Date.now() - startTime;
  console.error(`[Macrodata] Index rebuilt in ${duration}ms`);

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
