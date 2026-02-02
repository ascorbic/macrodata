/**
 * OpenCode Conversation Indexer
 *
 * Indexes past OpenCode sessions for semantic search.
 * Structure: ~/.local/share/opencode/storage/
 *   - message/{sessionID}/msg_{id}.json - Message metadata
 *   - part/{messageID}/prt_{id}.json - Message content
 *   - project/{hash}.json - Project metadata
 */

import { existsSync, readFileSync, readdirSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { LocalIndex } from "vectra";
import { pipeline, type FeatureExtractionPipeline } from "@xenova/transformers";
import { getStateRoot } from "./context.js";

const OPENCODE_STORAGE = join(homedir(), ".local", "share", "opencode", "storage");
const EMBEDDING_DIMENSIONS = 384;

// Reuse embedding pipeline from search.ts
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineLoading: Promise<FeatureExtractionPipeline> | null = null;

async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) return embeddingPipeline;
  if (pipelineLoading) return pipelineLoading;

  console.error("[Macrodata] Loading embedding model...");
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
    console.error("[Macrodata] Creating new conversation index...");
    await convIndex.createIndex();
  }

  return convIndex;
}

interface ProjectInfo {
  id: string;
  worktree: string;
  name: string;
}

interface MessageInfo {
  id: string;
  sessionID: string;
  role: "user" | "assistant";
  timestamp: number;
  agent?: string;
}

interface PartInfo {
  id: string;
  messageID: string;
  type: string;
  text?: string;
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
 * Load project mappings
 */
function loadProjects(): Map<string, ProjectInfo> {
  const projects = new Map<string, ProjectInfo>();
  const projectDir = join(OPENCODE_STORAGE, "project");

  if (!existsSync(projectDir)) return projects;

  const files = readdirSync(projectDir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    try {
      const data = JSON.parse(readFileSync(join(projectDir, file), "utf-8"));
      projects.set(data.id, {
        id: data.id,
        worktree: data.worktree,
        name: basename(data.worktree),
      });
    } catch {
      // Skip
    }
  }

  return projects;
}

/**
 * Get text content from message parts
 */
function getMessageText(messageId: string): string {
  const partsDir = join(OPENCODE_STORAGE, "part", messageId);
  if (!existsSync(partsDir)) return "";

  const parts: string[] = [];
  const files = readdirSync(partsDir).filter((f) => f.endsWith(".json"));

  for (const file of files) {
    try {
      const part: PartInfo = JSON.parse(readFileSync(join(partsDir, file), "utf-8"));
      if (part.type === "text" && part.text) {
        parts.push(part.text);
      }
    } catch {
      // Skip
    }
  }

  return parts.join("\n").slice(0, 2000); // Limit length
}

/**
 * Scan all OpenCode sessions and extract exchanges
 */
function* scanExchanges(): Generator<ConversationExchange> {
  const messageDir = join(OPENCODE_STORAGE, "message");
  if (!existsSync(messageDir)) return;

  const projects = loadProjects();
  const sessionDirs = readdirSync(messageDir);

  for (const sessionId of sessionDirs) {
    const sessionPath = join(messageDir, sessionId);
    if (!existsSync(sessionPath)) continue;

    // Get all messages in this session
    const msgFiles = readdirSync(sessionPath)
      .filter((f) => f.endsWith(".json"))
      .sort(); // Sort by ID for chronological order

    const messages: Array<MessageInfo & { text: string }> = [];

    for (const file of msgFiles) {
      try {
        const msg: MessageInfo = JSON.parse(readFileSync(join(sessionPath, file), "utf-8"));
        const text = getMessageText(msg.id);
        if (text) {
          messages.push({ ...msg, text });
        }
      } catch {
        // Skip
      }
    }

    // Extract user-assistant pairs
    for (let i = 0; i < messages.length - 1; i++) {
      const user = messages[i];
      const assistant = messages[i + 1];

      if (user.role === "user" && assistant.role === "assistant") {
        // Try to find project from session
        // OpenCode doesn't directly link session to project in message metadata
        // We'd need to check session storage or use current directory heuristics
        const projectPath = ""; // TODO: Could parse from session metadata
        const projectName = projectPath ? basename(projectPath) : "unknown";

        yield {
          id: `oc-${sessionId}-${user.id}`,
          userPrompt: user.text.slice(0, 1000),
          assistantSummary: assistant.text.slice(0, 500),
          project: projectName,
          projectPath,
          timestamp: new Date(user.timestamp).toISOString(),
          sessionId,
          messageId: user.id,
        };

        i++; // Skip the assistant message
      }
    }
  }
}

/**
 * Rebuild conversation index
 */
export async function rebuildConversationIndex(): Promise<{ exchangeCount: number }> {
  console.error("[Macrodata] Rebuilding OpenCode conversation index...");
  const startTime = Date.now();

  const exchanges: ConversationExchange[] = [];
  for (const exchange of scanExchanges()) {
    exchanges.push(exchange);
  }

  console.error(`[Macrodata] Found ${exchanges.length} exchanges`);

  if (exchanges.length === 0) {
    return { exchangeCount: 0 };
  }

  // Embed user prompts (what we search on)
  const texts = exchanges.map((e) => e.userPrompt);
  console.error(`[Macrodata] Generating embeddings...`);
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
  console.error(`[Macrodata] Conversation index rebuilt in ${duration}ms`);

  return { exchangeCount: exchanges.length };
}

/**
 * Time-based weight for scoring
 */
function getTimeWeight(timestamp: string): number {
  const age = Date.now() - new Date(timestamp).getTime();
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
