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

import { readdirSync, readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { embed, embedBatch } from "./embeddings.js";
import { LocalIndex } from "vectra";
import { getIndexDir } from "./config.js";

// Index state tracking for incremental updates
interface IndexState {
  files: Record<string, { mtime: number; exchangeIds: string[] }>;
  lastUpdate: string;
}

function getIndexStatePath(): string {
  return join(getIndexDir(), "conversations-state.json");
}

function loadIndexState(): IndexState {
  const statePath = getIndexStatePath();
  if (existsSync(statePath)) {
    try {
      return JSON.parse(readFileSync(statePath, "utf-8"));
    } catch {
      console.warn("[Conversations] Index state corrupted, starting fresh");
    }
  }
  return { files: {}, lastUpdate: "" };
}

function saveIndexState(state: IndexState): void {
  const statePath = getIndexStatePath();
  const dir = getIndexDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// Configuration
const CLAUDE_DIR = join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

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

// Cached index with path tracking
let convIndex: LocalIndex | null = null;
let convIndexPath: string | null = null;

async function getConversationIndex(): Promise<LocalIndex> {
  const currentIndexDir = getIndexDir();
  const currentIndexPath = join(currentIndexDir, "conversations");

  // Invalidate cache if path changed
  if (convIndex && convIndexPath !== currentIndexPath) {
    convIndex = null;
    convIndexPath = null;
  }

  if (convIndex) return convIndex;

  if (!existsSync(currentIndexDir)) {
    const { mkdirSync } = await import("fs");
    mkdirSync(currentIndexDir, { recursive: true });
  }

  convIndex = new LocalIndex(currentIndexPath);
  convIndexPath = currentIndexPath;

  if (!(await convIndex.isIndexCreated())) {
    console.log("[Conversations] Creating new conversation index...");
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
 * Check if user message content is a tool result (not an actual user prompt)
 */
function isToolResult(content: unknown): boolean {
  if (Array.isArray(content)) {
    // Array content with tool_result or tool_use_id = tool result, not user prompt
    return content.some(item =>
      item.type === "tool_result" ||
      item.tool_use_id !== undefined
    );
  }
  return false;
}

/**
 * Check if content is noise we should skip indexing
 */
function isNoiseContent(content: string): boolean {
  // Skip compacted session summaries
  if (content.startsWith("This session is being continued from a previous conversation")) {
    return true;
  }

  // Skip local command outputs
  if (content.includes("<local-command-stdout>") ||
      content.includes("<local-command-caveat>") ||
      content.includes("<command-name>")) {
    return true;
  }

  // Skip hook-injected context (standalone, not part of agent context)
  if (content.startsWith("<current_time>") ||
      content.startsWith("<context_status>") ||
      content.startsWith("<state_files>") ||
      content.startsWith("<system-reminder>") ||
      content.startsWith("## Current State Files") ||
      content.startsWith("Base directory for this skill:")) {
    return true;
  }

  // Skip empty messages
  if (content.trim().length < 1) {
    return true;
  }

  return false;
}

/**
 * Extract actual user text from message content, filtering out tool results
 */
function extractUserText(content: string | unknown[]): string {
  let text = "";

  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    // Array content - try to find actual text blocks
    for (const block of content) {
      const b = block as Record<string, unknown>;
      // Skip tool results
      if (b.type === "tool_result" || b.tool_use_id !== undefined) {
        continue;
      }
      // Look for text content
      if (b.type === "text" && typeof b.text === "string") {
        text = b.text;
        break;
      }
    }
  }

  if (!text) return "";

  // Extract actual user message from agent context blocks
  // These have format: "# Agent Context\n...\nUser message: <actual message>"
  if (text.startsWith("# Agent Context") || text.includes("\nUser message: ")) {
    const userMsgMatch = text.match(/\nUser message: (.+)$/s);
    if (userMsgMatch) {
      return userMsgMatch[1].trim();
    }
    // No user message found in context block - skip it
    return "";
  }

  return text;
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

    let currentUser: { msg: ConversationMessage; text: string } | null = null;
    let malformedLines = 0;

    for (const line of lines) {
      try {
        const msg: ConversationMessage = JSON.parse(line);

        if (msg.type === "user" && msg.message?.content) {
          // Skip tool results - these aren't actual user prompts
          if (isToolResult(msg.message.content)) {
            continue;
          }

          // Extract the actual text
          const userText = extractUserText(msg.message.content);

          // Skip noise (command outputs, compacted summaries, very short messages)
          if (!userText || isNoiseContent(userText)) {
            continue;
          }

          currentUser = { msg, text: userText };
        } else if (msg.type === "assistant" && currentUser && msg.message?.content) {
          // Found a user-assistant pair
          const assistantText = extractAssistantText(msg.message.content);

          if (currentUser.text) {
            exchanges.push({
              id: `conv-${currentUser.msg.sessionId}-${currentUser.msg.uuid}`,
              userPrompt: currentUser.text.slice(0, 1000),
              assistantSummary: assistantText,
              project: projectName,
              projectPath: projectPath,
              branch: currentUser.msg.gitBranch,
              timestamp: currentUser.msg.timestamp || new Date().toISOString(),
              sessionId: currentUser.msg.sessionId || basename(filePath, ".jsonl"),
              sessionPath: filePath,
              messageUuid: currentUser.msg.uuid || "",
            });
          }

          currentUser = null; // Reset for next exchange
        }
      } catch {
        malformedLines++;
      }
    }

    if (malformedLines > 0) {
      console.warn(`[Conversations] Skipped ${malformedLines} malformed lines in ${filePath}`);
    }
  } catch (err) {
    console.error(`[Conversations] Failed to parse ${filePath}: ${String(err)}`);
  }

  return exchanges;
}

/**
 * Scan all Claude project directories for conversation files
 */
function* scanConversationFiles(): Generator<{ filePath: string; projectPath: string; mtime: number }> {
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

      const filePath = join(projectFullPath, file);
      const mtime = statSync(filePath).mtimeMs;

      yield { filePath, projectPath, mtime };
    }
  }
}

/**
 * Rebuild the conversation index from scratch
 */
export async function rebuildConversationIndex(): Promise<{ exchangeCount: number }> {
  console.log("[Conversations] Starting full index rebuild...");
  const startTime = Date.now();

  const allExchanges: ConversationExchange[] = [];
  const newState: IndexState = { files: {}, lastUpdate: new Date().toISOString() };

  for (const { filePath, projectPath, mtime } of scanConversationFiles()) {
    const exchanges = parseConversationFile(filePath, projectPath);
    allExchanges.push(...exchanges);
    newState.files[filePath] = {
      mtime,
      exchangeIds: exchanges.map(e => e.id),
    };
  }

  console.log(`[Conversations] Found ${allExchanges.length} exchanges`);

  if (allExchanges.length === 0) {
    saveIndexState(newState);
    return { exchangeCount: 0 };
  }

  // Create embeddings for all exchanges
  const texts = allExchanges.map(e =>
    `${e.project}${e.branch ? ` (${e.branch})` : ""}: ${e.userPrompt}`
  );

  console.log(`[Conversations] Generating embeddings...`);
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

  saveIndexState(newState);

  const duration = Date.now() - startTime;
  console.log(`[Conversations] Full rebuild complete in ${duration}ms`);

  return { exchangeCount: allExchanges.length };
}

/**
 * Incrementally update the conversation index (only changed files)
 */
export async function updateConversationIndex(): Promise<{ exchangeCount: number; filesUpdated: number; skipped: number }> {
  console.log("[Conversations] Starting incremental update...");
  const startTime = Date.now();

  const state = loadIndexState();
  const idx = await getConversationIndex();

  // Check if index exists - if not, do full rebuild
  if (!(await idx.isIndexCreated())) {
    console.log("[Conversations] No existing index, doing full rebuild");
    const result = await rebuildConversationIndex();
    return { exchangeCount: result.exchangeCount, filesUpdated: 0, skipped: 0 };
  }

  let filesUpdated = 0;
  let skipped = 0;
  let totalExchanges = 0;
  const currentFiles = new Set<string>();

  for (const { filePath, projectPath, mtime } of scanConversationFiles()) {
    currentFiles.add(filePath);
    const cached = state.files[filePath];

    // Skip if file hasn't changed
    if (cached && cached.mtime === mtime) {
      skipped++;
      totalExchanges += cached.exchangeIds.length;
      continue;
    }

    // File is new or modified - parse and index
    const exchanges = parseConversationFile(filePath, projectPath);

    if (exchanges.length > 0) {
      const texts = exchanges.map(e =>
        `${e.project}${e.branch ? ` (${e.branch})` : ""}: ${e.userPrompt}`
      );
      const vectors = await embedBatch(texts);

      for (let i = 0; i < exchanges.length; i++) {
        const exchange = exchanges[i];
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
    }

    state.files[filePath] = {
      mtime,
      exchangeIds: exchanges.map(e => e.id),
    };
    filesUpdated++;
    totalExchanges += exchanges.length;
  }

  // Clean up deleted files from state (but don't remove from index - they may still be useful)
  for (const filePath of Object.keys(state.files)) {
    if (!currentFiles.has(filePath)) {
      delete state.files[filePath];
    }
  }

  state.lastUpdate = new Date().toISOString();
  saveIndexState(state);

  const duration = Date.now() - startTime;
  console.log(`[Conversations] Incremental update complete in ${duration}ms (${filesUpdated} files updated, ${skipped} skipped)`);

  return { exchangeCount: totalExchanges, filesUpdated, skipped };
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
    console.log("[Conversations] Index is empty");
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
  let malformedLines = 0;

  // Parse all messages
  for (const line of lines) {
    try {
      const msg: ConversationMessage = JSON.parse(line);

      if (msg.type === "user" && msg.message?.content) {
        // Skip tool results
        if (isToolResult(msg.message.content)) {
          continue;
        }

        const text = extractUserText(msg.message.content);

        // Skip empty or noise content
        if (!text || isNoiseContent(text)) {
          continue;
        }

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
        if (text) {
          messages.push({
            role: "assistant",
            content: text,
            timestamp: msg.timestamp,
            uuid: msg.uuid,
          });
        }
      }
    } catch {
      malformedLines++;
    }
  }

  if (malformedLines > 0) {
    console.warn(`[Conversations] Skipped ${malformedLines} malformed lines in ${sessionPath}`);
  }

  // Find the target message index
  const targetIdx = messages.findIndex(m => m.uuid === messageUuid);

  if (targetIdx === -1) {
    // Return last N messages if target not found
    return {
      messages: messages.slice(-contextMessages).map(({ uuid: _uuid, ...rest }) => rest),
      project,
      branch,
    };
  }

  // Return context around target
  const start = Math.max(0, targetIdx - Math.floor(contextMessages / 2));
  const end = Math.min(messages.length, start + contextMessages);

  return {
    messages: messages.slice(start, end).map(({ uuid: _uuid, ...rest }) => rest),
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
