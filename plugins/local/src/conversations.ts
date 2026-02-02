/**
 * Claude Conversation Log Parser and Indexer
 * 
 * Indexes conversation "exchanges" from Claude Code's log files for semantic search.
 * Each exchange = user prompt + assistant's first text response.
 * 
 * Features:
 * - Project-biased search (current project first, then global)
 * - Time-weighted scoring (recent > old)
 * - Metadata: project, branch, timestamp, session
 */

import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { embed, embedBatch } from "./embeddings.js";
import { LocalIndex } from "vectra";

// Configuration
const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");
const STATE_ROOT = process.env.MACRODATA_ROOT || join(homedir(), ".config", "macrodata");
const CONV_INDEX_PATH = join(STATE_ROOT, ".index", "conversations");

// Types
interface ConversationMessage {
  type: "user" | "assistant" | "file-history-snapshot";
  message?: {
    role: string;
    content: string | Array<{ type: string; text?: string; thinking?: string }>;
  };
  uuid?: string;
  parentUuid?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
}

export interface ConversationExchange {
  id: string;
  userPrompt: string;
  assistantSummary: string;
  project: string;
  projectPath: string;
  branch?: string;
  timestamp: string;
  sessionId: string;
  sessionPath: string;
  messageUuid: string;
}

export interface ConversationSearchResult {
  exchange: ConversationExchange;
  score: number;
  adjustedScore: number; // After time weighting and project boost
}

// Singleton index
let convIndex: LocalIndex | null = null;

async function getConversationIndex(): Promise<LocalIndex> {
  if (convIndex) return convIndex;
  
  const indexDir = join(STATE_ROOT, ".index");
  if (!existsSync(indexDir)) {
    const { mkdirSync } = await import("fs");
    mkdirSync(indexDir, { recursive: true });
  }
  
  convIndex = new LocalIndex(CONV_INDEX_PATH);
  
  if (!(await convIndex.isIndexCreated())) {
    console.error("[Conversations] Creating new conversation index...");
    await convIndex.createIndex();
  }
  
  return convIndex;
}

/**
 * Decode project directory name back to path
 * e.g., "-Users-mkane-Repos-workers-sdk" -> "/Users/mkane/Repos/workers-sdk"
 */
function decodeProjectPath(encoded: string): string {
  return encoded.replace(/^-/, "/").replace(/-/g, "/");
}

/**
 * Extract project name from path
 */
function getProjectName(projectPath: string): string {
  return basename(projectPath);
}

/**
 * Extract first text content from assistant message
 */
function extractAssistantText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === "string") {
    return content.slice(0, 500);
  }
  
  for (const block of content) {
    if (block.type === "text" && block.text) {
      return block.text.slice(0, 500);
    }
  }
  
  return "";
}

/**
 * Parse a conversation file and extract exchanges
 */
function parseConversationFile(filePath: string, projectPath: string): ConversationExchange[] {
  const exchanges: ConversationExchange[] = [];
  const projectName = getProjectName(projectPath);
  
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    
    let currentUser: ConversationMessage | null = null;
    
    for (const line of lines) {
      try {
        const msg: ConversationMessage = JSON.parse(line);
        
        if (msg.type === "user" && msg.message?.content) {
          currentUser = msg;
        } else if (msg.type === "assistant" && currentUser && msg.message?.content) {
          // Found a user-assistant pair
          const userContent = typeof currentUser.message?.content === "string" 
            ? currentUser.message.content 
            : "";
          const assistantText = extractAssistantText(msg.message.content);
          
          if (userContent && assistantText) {
            exchanges.push({
              id: `conv-${currentUser.sessionId}-${currentUser.uuid}`,
              userPrompt: userContent.slice(0, 1000),
              assistantSummary: assistantText,
              project: projectName,
              projectPath: projectPath,
              branch: currentUser.gitBranch,
              timestamp: currentUser.timestamp || new Date().toISOString(),
              sessionId: currentUser.sessionId || basename(filePath, ".jsonl"),
              sessionPath: filePath,
              messageUuid: currentUser.uuid || "",
            });
          }
          
          currentUser = null; // Reset for next exchange
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err) {
    console.error(`[Conversations] Failed to parse ${filePath}: ${err}`);
  }
  
  return exchanges;
}

/**
 * Scan all Claude project directories for conversation files
 */
function* scanConversationFiles(): Generator<{ filePath: string; projectPath: string }> {
  if (!existsSync(PROJECTS_DIR)) {
    return;
  }
  
  const projectDirs = readdirSync(PROJECTS_DIR);
  
  for (const projectDir of projectDirs) {
    if (projectDir.startsWith(".")) continue;
    
    const projectPath = decodeProjectPath(projectDir);
    const projectFullPath = join(PROJECTS_DIR, projectDir);
    
    if (!statSync(projectFullPath).isDirectory()) continue;
    
    const files = readdirSync(projectFullPath);
    
    for (const file of files) {
      // Skip agent files, only process main conversation files
      if (!file.endsWith(".jsonl") || file.startsWith("agent-")) continue;
      
      yield {
        filePath: join(projectFullPath, file),
        projectPath,
      };
    }
  }
}

/**
 * Rebuild the conversation index from scratch
 */
export async function rebuildConversationIndex(): Promise<{ exchangeCount: number }> {
  console.error("[Conversations] Starting conversation index rebuild...");
  const startTime = Date.now();
  
  const allExchanges: ConversationExchange[] = [];
  
  for (const { filePath, projectPath } of scanConversationFiles()) {
    const exchanges = parseConversationFile(filePath, projectPath);
    allExchanges.push(...exchanges);
  }
  
  console.error(`[Conversations] Found ${allExchanges.length} exchanges`);
  
  if (allExchanges.length === 0) {
    return { exchangeCount: 0 };
  }
  
  // Create embeddings for all exchanges
  // Embedding text = project + branch + user prompt (intent-focused)
  const texts = allExchanges.map(e => 
    `${e.project}${e.branch ? ` (${e.branch})` : ""}: ${e.userPrompt}`
  );
  
  console.error(`[Conversations] Generating embeddings...`);
  const vectors = await embedBatch(texts);
  
  const idx = await getConversationIndex();
  
  // Index all exchanges
  for (let i = 0; i < allExchanges.length; i++) {
    const exchange = allExchanges[i];
    await idx.upsertItem({
      id: exchange.id,
      vector: vectors[i],
      metadata: {
        userPrompt: exchange.userPrompt,
        assistantSummary: exchange.assistantSummary,
        project: exchange.project,
        projectPath: exchange.projectPath,
        branch: exchange.branch || "",
        timestamp: exchange.timestamp,
        sessionId: exchange.sessionId,
        sessionPath: exchange.sessionPath,
        messageUuid: exchange.messageUuid,
      },
    });
  }
  
  const duration = Date.now() - startTime;
  console.error(`[Conversations] Index rebuild complete in ${duration}ms`);
  
  return { exchangeCount: allExchanges.length };
}

/**
 * Calculate time-based weight for scoring
 * Recent = higher weight
 */
function getTimeWeight(timestamp: string): number {
  const age = Date.now() - new Date(timestamp).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  
  if (age < 7 * dayMs) return 1.0;      // Last week: full weight
  if (age < 30 * dayMs) return 0.9;     // Last month: 90%
  if (age < 90 * dayMs) return 0.7;     // Last 3 months: 70%
  if (age < 365 * dayMs) return 0.5;    // Last year: 50%
  return 0.3;                            // Older: 30%
}

/**
 * Search conversations with project bias and time weighting
 */
export async function searchConversations(
  query: string,
  options: {
    currentProject?: string;  // Path to current project for boosting
    limit?: number;
    projectOnly?: boolean;    // Only search current project
  } = {}
): Promise<ConversationSearchResult[]> {
  const { currentProject, limit = 5, projectOnly = false } = options;
  
  const idx = await getConversationIndex();
  const stats = await idx.listItems();
  
  if (stats.length === 0) {
    console.error("[Conversations] Index is empty");
    return [];
  }
  
  const queryVector = await embed(query);
  
  // Get more results than needed for filtering/reranking
  const results = await idx.queryItems(queryVector, limit * 3);
  
  // Convert to search results with adjusted scoring
  const searchResults: ConversationSearchResult[] = results.map(r => {
    const meta = r.item.metadata as Record<string, string>;
    
    const exchange: ConversationExchange = {
      id: r.item.id,
      userPrompt: meta.userPrompt,
      assistantSummary: meta.assistantSummary,
      project: meta.project,
      projectPath: meta.projectPath,
      branch: meta.branch || undefined,
      timestamp: meta.timestamp,
      sessionId: meta.sessionId,
      sessionPath: meta.sessionPath,
      messageUuid: meta.messageUuid,
    };
    
    // Calculate adjusted score
    let adjustedScore = r.score;
    
    // Time weighting
    adjustedScore *= getTimeWeight(exchange.timestamp);
    
    // Project boost (1.5x for current project)
    if (currentProject && exchange.projectPath === currentProject) {
      adjustedScore *= 1.5;
    }
    
    return {
      exchange,
      score: r.score,
      adjustedScore,
    };
  });
  
  // Filter to current project if requested
  let filtered = searchResults;
  if (projectOnly && currentProject) {
    filtered = searchResults.filter(r => r.exchange.projectPath === currentProject);
  }
  
  // Sort by adjusted score and limit
  return filtered
    .sort((a, b) => b.adjustedScore - a.adjustedScore)
    .slice(0, limit);
}

/**
 * Load full conversation context around a specific message
 */
export async function expandConversation(
  sessionPath: string,
  messageUuid: string,
  contextMessages: number = 10
): Promise<{
  messages: Array<{ role: string; content: string; timestamp?: string }>;
  project: string;
  branch?: string;
}> {
  if (!existsSync(sessionPath)) {
    throw new Error(`Session file not found: ${sessionPath}`);
  }
  
  const content = readFileSync(sessionPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  
  const messages: Array<{ role: string; content: string; timestamp?: string; uuid?: string }> = [];
  let project = "";
  let branch: string | undefined;
  
  // Parse all messages
  for (const line of lines) {
    try {
      const msg: ConversationMessage = JSON.parse(line);
      
      if (msg.type === "user" && msg.message?.content) {
        const text = typeof msg.message.content === "string" 
          ? msg.message.content 
          : msg.message.content.map(b => b.text || "").join("");
        
        messages.push({
          role: "user",
          content: text,
          timestamp: msg.timestamp,
          uuid: msg.uuid,
        });
        
        if (!project && msg.cwd) {
          project = getProjectName(msg.cwd);
        }
        if (!branch && msg.gitBranch) {
          branch = msg.gitBranch;
        }
      } else if (msg.type === "assistant" && msg.message?.content) {
        const text = extractAssistantText(msg.message.content);
        messages.push({
          role: "assistant",
          content: text,
          timestamp: msg.timestamp,
          uuid: msg.uuid,
        });
      }
    } catch {
      // Skip malformed lines
    }
  }
  
  // Find the target message index
  const targetIdx = messages.findIndex(m => m.uuid === messageUuid);
  
  if (targetIdx === -1) {
    // Return last N messages if target not found
    return {
      messages: messages.slice(-contextMessages).map(({ uuid, ...rest }) => rest),
      project,
      branch,
    };
  }
  
  // Return context around target
  const start = Math.max(0, targetIdx - Math.floor(contextMessages / 2));
  const end = Math.min(messages.length, start + contextMessages);
  
  return {
    messages: messages.slice(start, end).map(({ uuid, ...rest }) => rest),
    project,
    branch,
  };
}

/**
 * Get conversation index stats
 */
export async function getConversationIndexStats(): Promise<{ exchangeCount: number }> {
  const idx = await getConversationIndex();
  const items = await idx.listItems();
  return { exchangeCount: items.length };
}
