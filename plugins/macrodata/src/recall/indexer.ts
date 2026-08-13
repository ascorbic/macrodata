/**
 * Ambient-recall indexer — Qwen3/1024 Vectra index over macrodata markdown.
 *
 * Parsing (journal JSONL + per-section entity splitting) is ported verbatim
 * from src/indexer.ts so both indexes hold the same units. The differences are:
 * Qwen3 doc/query embeddings, 1024-dim, and a separate index dir
 * (config.getIndexDir) — MiniLM/384 and Qwen3/1024 cannot share a Vectra store.
 */

import { LocalIndex } from "vectra";
import { join } from "path";
import { readFileSync, readdirSync, existsSync, mkdirSync } from "fs";
import { embedDocuments, embedQuery } from "./embeddings.ts";
import { getIndexDir, getEntitiesDir, getJournalDir } from "./config.ts";

export type MemoryItemType = string;

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
  score: number; // FINAL score = pure cross-encoder rerank (0-1)
  // Per-stage diagnostics (carried through for calibration; not used in ranking):
  rrf?: number; // RRF-fused recall score (vector+FTS), pre-recency, pre-rerank
  recency?: number; // recency decay factor (0-1) applied for candidate SELECTION only
  wRank?: number; // 1-based rank in the pre-MMR w-sorted slate; wRank > pool size = MMR created this slot
  mmrPick?: number; // 1-based MMR selection order; absent = MMR bypassed (small slate / lambda>=1)
  mmrSim?: number; // redundancy penalty (max cosine/Jaccard vs earlier picks) at pick time; 0 for the first pick
}

let index: LocalIndex | null = null;

// Drop the cached LocalIndex (it holds index.json in memory) so the next call
// re-reads from disk. Called by the staleness check in fts.ts when a reindex
// bumps the on-disk index — without it the long-lived worker serves the old
// snapshot forever.
export function resetIndexCache(): void {
  index = null;
}

async function getIndex(): Promise<LocalIndex> {
  const dir = getIndexDir();
  if (index) return index;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  index = new LocalIndex(join(dir, "vectors"));
  if (!(await index.isIndexCreated())) {
    await index.createIndex();
  }
  return index;
}

// Embed a length-capped view of each doc — long sections dilute the embedding
// and blew fp32 activation memory. Full content is still stored in metadata for
// display/return; only the embedding input is truncated.
const MAX_EMBED_CHARS = 2000;
const INDEX_BATCH = 8;

async function indexItems(items: MemoryItem[]): Promise<void> {
  if (items.length === 0) return;
  const idx = await getIndex();
  const t0 = Date.now();

  // Embed -> upsert -> log per batch (NOT embed-all-then-write): incremental
  // persistence (resumable / survives a kill), bounded memory, visible progress.
  for (let i = 0; i < items.length; i += INDEX_BATCH) {
    const batch = items.slice(i, i + INDEX_BATCH);
    const vectors = await embedDocuments(batch.map((it) => it.content.slice(0, MAX_EMBED_CHARS)));
    for (let j = 0; j < batch.length; j++) {
      const item = batch[j];
      const metadata: Record<string, string | number | boolean> = {
        type: item.type,
        content: item.content,
        source: item.source,
      };
      if (item.section) metadata.section = item.section;
      if (item.timestamp) metadata.timestamp = item.timestamp;
      await idx.upsertItem({ id: item.id, vector: vectors[j], metadata });
    }
    const done = Math.min(i + INDEX_BATCH, items.length);
    if (done % (INDEX_BATCH * 10) === 0 || done === items.length) {
      const rate = done / ((Date.now() - t0) / 1000);
      console.log(`[macrodata-recall]${done}/${items.length} indexed (${rate.toFixed(1)} items/s)`);
    }
  }
}

function parseJournalForIndexing(): MemoryItem[] {
  const items: MemoryItem[] = [];
  const journalDir = getJournalDir();
  if (!existsSync(journalDir)) return items;

  for (const file of readdirSync(journalDir).filter((f) => f.endsWith(".jsonl"))) {
    try {
      const lines = readFileSync(join(journalDir, file), "utf-8").trim().split("\n").filter(Boolean);
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
          // skip malformed line
        }
      }
    } catch {
      // skip unreadable file
    }
  }
  return items;
}

function parseEntitiesForIndexing(subdir: string, type: MemoryItemType): MemoryItem[] {
  const items: MemoryItem[] = [];
  const dir = join(getEntitiesDir(), subdir);
  if (!existsSync(dir)) return items;

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      const filename = file.replace(".md", "");
      const sections = content.split(/^## /m);

      if (sections[0].trim()) {
        items.push({
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
      // skip unreadable file
    }
  }
  return items;
}

// The live corpus, as ids. Scanning is cheap (file reads, no embedding), which
// is what lets pruneOrphans run standalone in seconds.
function collectItems(): MemoryItem[] {
  const allItems: MemoryItem[] = [];

  allItems.push(...parseJournalForIndexing());

  const entitiesDir = getEntitiesDir();
  if (existsSync(entitiesDir)) {
    for (const dirent of readdirSync(entitiesDir, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.name.startsWith(".")) continue;
      allItems.push(...parseEntitiesForIndexing(dirent.name, dirent.name));
    }
  }

  return allItems;
}

// indexItems only ever upserts, so a vector outlives the journal line, section,
// or file it came from and keeps scoring against live material forever. Nothing
// else deletes, so the index only converges on the corpus if the ids the scan
// no longer produces are removed here.
export async function pruneOrphans(scanned?: MemoryItem[]): Promise<{ pruned: number; kept: number }> {
  const items = scanned ?? collectItems();
  const idx = await getIndex();
  const indexed = await idx.listItems();

  // An empty scan means an unreadable or misconfigured data root far more often
  // than a genuinely empty corpus, and pruning against it would delete every
  // vector. Refuse rather than reconcile to zero.
  if (items.length === 0) {
    if (indexed.length > 0) console.log(`[macrodata-recall]prune skipped: scan found 0 items, index holds ${indexed.length}`);
    return { pruned: 0, kept: indexed.length };
  }

  const live = new Set(items.map((it) => it.id));
  const orphans = indexed.filter((it) => !live.has(it.id));
  for (const orphan of orphans) await idx.deleteItem(orphan.id);

  return { pruned: orphans.length, kept: indexed.length - orphans.length };
}

export async function rebuildIndex(): Promise<{ itemCount: number; pruned: number }> {
  const start = Date.now();
  const allItems = collectItems();

  console.log(`[macrodata-recall]embedding + indexing ${allItems.length} items (Qwen3/1024)…`);
  await indexItems(allItems);

  const { pruned } = await pruneOrphans(allItems);
  if (pruned > 0) console.log(`[macrodata-recall]pruned ${pruned} orphaned vectors`);

  console.log(`[macrodata-recall]rebuild complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  return { itemCount: allItems.length, pruned };
}

export async function searchMemory(
  query: string,
  options: { limit?: number; type?: MemoryItemType; since?: string; task?: string } = {},
): Promise<SearchResult[]> {
  const { limit = 5, type, since, task } = options;
  const idx = await getIndex();

  const all = await idx.listItems();
  if (all.length === 0) return [];

  const queryVector = await embedQuery(query, task);
  const results = await idx.queryItems(queryVector, limit * 4);

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
