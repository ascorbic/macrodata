/**
 * OpenCode Conversation Indexer
 *
 * Indexes past OpenCode sessions for semantic search.
 * Reads from the OpenCode SQLite database at ~/.local/share/opencode/opencode.db
 *
 * Schema (relevant tables):
 *   - session: id, project_id, title, time_created, time_updated, parent_id
 *   - message: id, session_id, time_created, data (JSON with role, agent, etc.)
 *   - part: id, message_id, session_id, data (JSON with type, text, etc.)
 *   - project: id, worktree
 */

import { existsSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { Database } from "bun:sqlite";
import { LocalIndex } from "vectra";
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { getStateRoot } from "./context.js";
import { logger } from "./logger.js";

const OPENCODE_DB_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db");
const EMBEDDING_DIMENSIONS = 384;

// Reuse embedding pipeline from search.ts
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineLoading: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) return embeddingPipeline;
  if (pipelineLoading) return pipelineLoading;

  pipelineLoading = pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
    quantized: true,
  });

  try {
    embeddingPipeline = await pipelineLoading;
    return embeddingPipeline;
  } finally {
    pipelineLoading = null;
  }
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

async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();
  const output = await pipe(text, { pooling: "mean", normalize: true });
  return Array.from(output.data as Float32Array);
}

// Conversation index singleton
let convIndex: LocalIndex | null = null;

async function getConversationIndex(): Promise<LocalIndex> {
  if (convIndex) return convIndex;

  const stateRoot = getStateRoot();
  const indexPath = join(stateRoot, ".index", "oc-conversations");

  const indexDir = join(stateRoot, ".index");
  if (!existsSync(indexDir)) {
    mkdirSync(indexDir, { recursive: true });
  }

  convIndex = new LocalIndex(indexPath);

  if (!(await convIndex.isIndexCreated())) {
    logger.log("Creating new conversation index...");
    await convIndex.createIndex();
  }

  return convIndex;
}

export interface ConversationExchange {
  id: string;
  userPrompt: string;
  assistantSummary: string;
  project: string;
  projectPath: string;
  timestamp: string;
  sessionId: string;
  messageId: string;
}

export interface ConversationSearchResult {
  exchange: ConversationExchange;
  score: number;
  adjustedScore: number;
}

/**
 * Open the OpenCode SQLite database (read-only)
 */
function openDb(): Database | null {
  if (!existsSync(OPENCODE_DB_PATH)) {
    logger.log(`OpenCode database not found at ${OPENCODE_DB_PATH}`);
    return null;
  }

  try {
    return new Database(OPENCODE_DB_PATH, { readonly: true });
  } catch (err) {
    logger.error(`Failed to open OpenCode database: ${err}`);
    return null;
  }
}

interface ExchangeRow {
  user_msg_id: string;
  session_id: string;
  user_time: number;
  user_text: string;
  assistant_text: string;
  worktree: string | null;
}

/**
 * Query exchanges from the SQLite database.
 *
 * This runs a single query that:
 * 1. Finds user messages (role = 'user') that aren't compaction summaries
 * 2. Finds the next assistant message in the same session
 * 3. Aggregates text parts for both user and assistant messages
 * 4. Joins to project for worktree path
 * 5. Excludes subtask sessions (parent_id IS NULL)
 */
function queryExchanges(db: Database, sinceMs?: number): ExchangeRow[] {
  const whereClause = sinceMs ? "AND um.time_created > ?" : "";
  const params = sinceMs ? [sinceMs] : [];

  // Get user-assistant pairs with their text content.
  // We use a CTE to match each user message with its subsequent assistant message,
  // then aggregate text parts for both.
  const sql = `
    WITH user_messages AS (
      SELECT
        m.id AS user_msg_id,
        m.session_id,
        m.time_created AS user_time,
        m.data AS user_data,
        -- Find the next assistant message by time in the same session
        (
          SELECT am.id FROM message am
          WHERE am.session_id = m.session_id
            AND am.time_created > m.time_created
            AND json_extract(am.data, '$.role') = 'assistant'
          ORDER BY am.time_created ASC
          LIMIT 1
        ) AS assistant_msg_id
      FROM message m
      JOIN session s ON s.id = m.session_id
      WHERE json_extract(m.data, '$.role') = 'user'
        AND s.parent_id IS NULL
        AND json_extract(m.data, '$.summary') IS NULL
        ${whereClause}
    )
    SELECT
      um.user_msg_id,
      um.session_id,
      um.user_time,
      COALESCE(
        GROUP_CONCAT(
          CASE WHEN up.message_id = um.user_msg_id AND json_extract(up.data, '$.type') = 'text'
            THEN json_extract(up.data, '$.text')
          END,
          '\n'
        ),
        ''
      ) AS user_text,
      COALESCE(
        GROUP_CONCAT(
          CASE WHEN up.message_id = um.assistant_msg_id AND json_extract(up.data, '$.type') = 'text'
            THEN json_extract(up.data, '$.text')
          END,
          '\n'
        ),
        ''
      ) AS assistant_text,
      p.worktree
    FROM user_messages um
    LEFT JOIN part up ON up.message_id IN (um.user_msg_id, um.assistant_msg_id)
    LEFT JOIN session s ON s.id = um.session_id
    LEFT JOIN project p ON p.id = s.project_id
    WHERE um.assistant_msg_id IS NOT NULL
    GROUP BY um.user_msg_id
    HAVING user_text != ''
    ORDER BY um.user_time ASC
  `;

  try {
    return db.prepare(sql).all(...params) as ExchangeRow[];
  } catch (err) {
    logger.error(`Query failed: ${err}`);
    return [];
  }
}

/**
 * Convert raw DB rows to ConversationExchange objects
 */
function rowsToExchanges(rows: ExchangeRow[]): ConversationExchange[] {
  return rows.map((row) => {
    const worktree = row.worktree || "";
    const projectName = worktree ? basename(worktree) : "unknown";

    return {
      id: `oc-${row.session_id}-${row.user_msg_id}`,
      userPrompt: row.user_text.slice(0, 1000),
      assistantSummary: row.assistant_text.slice(0, 500),
      project: projectName,
      projectPath: worktree,
      timestamp: new Date(row.user_time).toISOString(),
      sessionId: row.session_id,
      messageId: row.user_msg_id,
    };
  });
}

/**
 * Rebuild conversation index from scratch
 */
export async function rebuildConversationIndex(): Promise<{ exchangeCount: number }> {
  logger.log("Rebuilding OpenCode conversation index...");
  const startTime = Date.now();

  const db = openDb();
  if (!db) return { exchangeCount: 0 };

  try {
    const rows = queryExchanges(db);
    const exchanges = rowsToExchanges(rows);

    logger.log(`Found ${exchanges.length} exchanges`);
    if (exchanges.length === 0) return { exchangeCount: 0 };

    const texts = exchanges.map((e) => e.userPrompt);
    logger.log("Generating embeddings...");
    const vectors = await embedBatch(texts);

    const idx = await getConversationIndex();

    for (let i = 0; i < exchanges.length; i++) {
      const ex = exchanges[i];
      await idx.upsertItem({
        id: ex.id,
        vector: vectors[i],
        metadata: {
          userPrompt: ex.userPrompt,
          assistantSummary: ex.assistantSummary,
          project: ex.project,
          projectPath: ex.projectPath,
          timestamp: ex.timestamp,
          sessionId: ex.sessionId,
          messageId: ex.messageId,
        },
      });
    }

    const duration = Date.now() - startTime;
    logger.log(`Conversation index rebuilt in ${duration}ms`);
    return { exchangeCount: exchanges.length };
  } finally {
    db.close();
  }
}

/**
 * Time-based weight for scoring
 */
function getTimeWeight(timestamp: string): number {
  const ts = new Date(timestamp);
  if (isNaN(ts.getTime())) return 0.5;

  const age = Date.now() - ts.getTime();
  const dayMs = 24 * 60 * 60 * 1000;

  if (age < 7 * dayMs) return 1.0;
  if (age < 30 * dayMs) return 0.9;
  if (age < 90 * dayMs) return 0.7;
  if (age < 365 * dayMs) return 0.5;
  return 0.3;
}

/**
 * Search past conversations
 */
export async function searchConversations(
  query: string,
  options: {
    currentProject?: string;
    limit?: number;
    projectOnly?: boolean;
  } = {}
): Promise<ConversationSearchResult[]> {
  const { currentProject, limit = 5, projectOnly = false } = options;

  const idx = await getConversationIndex();
  const stats = await idx.listItems();

  if (stats.length === 0) {
    return [];
  }

  const queryVector = await embed(query);
  const results = await idx.queryItems(queryVector, limit * 3);

  const searchResults: ConversationSearchResult[] = results.map((r) => {
    const meta = r.item.metadata as Record<string, string>;

    const exchange: ConversationExchange = {
      id: r.item.id,
      userPrompt: meta.userPrompt,
      assistantSummary: meta.assistantSummary,
      project: meta.project,
      projectPath: meta.projectPath,
      timestamp: meta.timestamp,
      sessionId: meta.sessionId,
      messageId: meta.messageId,
    };

    let adjustedScore = r.score;
    adjustedScore *= getTimeWeight(exchange.timestamp);

    if (currentProject && exchange.projectPath === currentProject) {
      adjustedScore *= 1.5;
    }

    return {
      exchange,
      score: r.score,
      adjustedScore,
    };
  });

  let filtered = searchResults;
  if (projectOnly && currentProject) {
    filtered = searchResults.filter((r) => r.exchange.projectPath === currentProject);
  }

  return filtered.sort((a, b) => b.adjustedScore - a.adjustedScore).slice(0, limit);
}

/**
 * Get conversation index stats
 */
export async function getConversationIndexStats(): Promise<{ exchangeCount: number }> {
  const idx = await getConversationIndex();
  const items = await idx.listItems();
  return { exchangeCount: items.length };
}

/**
 * Incrementally update conversation index (only new exchanges)
 */
export async function updateConversationIndex(): Promise<{ newCount: number; totalCount: number }> {
  logger.log("Updating OpenCode conversation index...");
  const startTime = Date.now();

  const db = openDb();
  if (!db) return { newCount: 0, totalCount: 0 };

  try {
    const idx = await getConversationIndex();
    const existingItems = await idx.listItems();
    const existingIds = new Set(existingItems.map((item) => item.id));

    // Find the most recent timestamp in the index to narrow the query
    let latestMs = 0;
    for (const item of existingItems) {
      const meta = item.metadata as Record<string, string>;
      if (meta.timestamp) {
        const ms = new Date(meta.timestamp).getTime();
        if (ms > latestMs) latestMs = ms;
      }
    }

    // Query only exchanges after the latest indexed timestamp (with some overlap for safety)
    const sinceMs = latestMs > 0 ? latestMs - 60_000 : undefined;
    const rows = queryExchanges(db, sinceMs);
    const allExchanges = rowsToExchanges(rows);

    // Filter to truly new exchanges
    const newExchanges = allExchanges.filter((ex) => !existingIds.has(ex.id));

    logger.log(`Found ${newExchanges.length} new exchanges (${existingIds.size} already indexed)`);

    if (newExchanges.length === 0) {
      return { newCount: 0, totalCount: existingIds.size };
    }

    const texts = newExchanges.map((e) => e.userPrompt);
    logger.log(`Generating embeddings for ${texts.length} new exchanges...`);
    const vectors = await embedBatch(texts);

    for (let i = 0; i < newExchanges.length; i++) {
      const ex = newExchanges[i];
      await idx.upsertItem({
        id: ex.id,
        vector: vectors[i],
        metadata: {
          userPrompt: ex.userPrompt,
          assistantSummary: ex.assistantSummary,
          project: ex.project,
          projectPath: ex.projectPath,
          timestamp: ex.timestamp,
          sessionId: ex.sessionId,
          messageId: ex.messageId,
        },
      });
    }

    const duration = Date.now() - startTime;
    const totalCount = existingIds.size + newExchanges.length;
    logger.log(`Added ${newExchanges.length} exchanges in ${duration}ms (total: ${totalCount})`);

    return { newCount: newExchanges.length, totalCount };
  } finally {
    db.close();
  }
}
