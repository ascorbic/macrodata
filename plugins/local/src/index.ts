/**
 * Macrodata Local MCP Server
 *
 * Provides tools for local file-based memory:
 * - get_context: Session bootstrap
 * - log_journal: Append timestamped entries (with auto-indexing)
 * - get_recent_journal: Get recent entries
 * - log_signal: Raw event logging for later analysis
 * - search_memory: Semantic search using Transformers.js
 * - rebuild_memory_index: Rebuild the search index
 * - get_memory_index_stats: Index statistics
 * - schedule_reminder: Cron-based reminders
 * - schedule_once: One-shot reminders
 * - list_reminders: List active schedules
 * - remove_reminder: Delete a reminder
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "fs";
import { join } from "path";
import {
  searchMemory as doSearchMemory,
  indexJournalEntry,
  rebuildIndex,
  getIndexStats,
  type MemoryItemType,
} from "./indexer.js";
import {
  searchConversations,
  expandConversation,
  rebuildConversationIndex,
  getConversationIndexStats,
} from "./conversations.js";
import {
  getStateRoot,
  getStateDir,
  getEntitiesDir,
  getJournalDir,
  getSignalsDir,
  getIndexDir,
  getSchedulesFile,
} from "./config.js";

// Types
interface JournalEntry {
  timestamp: string;
  topic: string;
  content: string;
  metadata?: {
    source?: string;
    intent?: string;
  };
}

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string;
  description: string;
  payload: string;
  agent?: "opencode" | "claude"; // Which agent CLI to trigger
  model?: string; // Optional model override (e.g., "anthropic/claude-opus-4-5")
  createdAt: string;
}

interface Signal {
  timestamp: string;
  type: string;
  context?: {
    file?: string;
    query?: string;
    trigger?: string;
  };
  raw?: unknown;
}

interface ScheduleStore {
  schedules: Schedule[];
}

// Helpers
function ensureDirectories() {
  const entitiesDir = getEntitiesDir();
  const dirs = [
    getStateRoot(),
    getStateDir(),
    entitiesDir,
    join(entitiesDir, "people"),
    join(entitiesDir, "projects"),
    getJournalDir(),
    getSignalsDir(),
    getIndexDir(),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

function readFileOrEmpty(path: string): string {
  try {
    if (existsSync(path)) {
      return readFileSync(path, "utf-8");
    }
  } catch {
    // Ignore
  }
  return "";
}

function loadSchedules(): ScheduleStore {
  try {
    const schedulesFile = getSchedulesFile();
    if (existsSync(schedulesFile)) {
      return JSON.parse(readFileSync(schedulesFile, "utf-8"));
    }
  } catch {
    // Ignore
  }
  return { schedules: [] };
}

function saveSchedules(store: ScheduleStore) {
  writeFileSync(getSchedulesFile(), JSON.stringify(store, null, 2));
}

function getTodayJournalPath(): string {
  const today = new Date().toISOString().split("T")[0];
  return join(getJournalDir(), `${today}.jsonl`);
}

function getRecentJournalEntries(count: number): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const journalDir = getJournalDir();

  // Get all journal files, sorted by name (date) descending
  if (!existsSync(journalDir)) return entries;

  const files = readdirSync(journalDir)
    .filter((f: string) => f.endsWith(".jsonl"))
    .sort()
    .reverse();

  for (const file of files) {
    if (entries.length >= count) break;

    const content = readFileSync(join(journalDir, file), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    for (const line of lines.reverse()) {
      if (entries.length >= count) break;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
  }

  return entries;
}

// Create MCP server
const server = new McpServer({
  name: "macrodata-local",
  version: "0.1.0",
});

// Tool: get_context
// NOTE: Context is auto-injected by SessionStart hook. This tool is rarely needed.
server.tool(
  "get_context",
  "Get macrodata paths. Context is auto-injected by hooks - only use this if you need path references.",
  {},
  async () => {
    ensureDirectories();

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            paths: {
              root: getStateRoot(),
              state: getStateDir(),
              entities: getEntitiesDir(),
              journal: getJournalDir(),
            },
          }, null, 2),
        },
      ],
    };
  }
);

// Tool: log_journal
server.tool(
  "log_journal",
  "Append a timestamped entry to the journal",
  {
    topic: z.string().describe("Category or tag for this entry"),
    content: z.string().describe("The actual note or observation"),
    source: z.string().optional().describe("Where this came from (conversation, cron, etc.)"),
    intent: z.string().optional().describe("What you were doing when logging this"),
  },
  async ({ topic, content, source, intent }) => {
    ensureDirectories();

    const entry: JournalEntry = {
      timestamp: new Date().toISOString(),
      topic,
      content,
      metadata: {
        ...(source && { source }),
        ...(intent && { intent }),
      },
    };

    const journalPath = getTodayJournalPath();
    appendFileSync(journalPath, JSON.stringify(entry) + "\n");

    // Index the entry for semantic search
    try {
      await indexJournalEntry(entry);
    } catch (err) {
      console.error("[log_journal] Failed to index entry:", err);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `Logged to journal: ${topic}`,
        },
      ],
    };
  }
);

// Tool: get_recent_journal
server.tool(
  "get_recent_journal",
  "Get the N most recent journal entries, optionally filtered by topic",
  {
    count: z.number().default(10).describe("Number of entries to retrieve"),
    topic: z.string().optional().describe("Filter by specific topic"),
  },
  async ({ count, topic }) => {
    let entries = getRecentJournalEntries(Math.min(count * 2, 100)); // Get more to filter
    
    if (topic) {
      entries = entries.filter(e => e.topic === topic);
    }
    
    entries = entries.slice(0, count);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(entries, null, 2),
        },
      ],
    };
  }
);

// Tool: log_signal
server.tool(
  "log_signal",
  "Log a raw event for later analysis. Signals are not indexed for search - they capture events that might matter later.",
  {
    type: z.string().describe("Event type (e.g., file_edit, search, reminder_fired)"),
    file: z.string().optional().describe("File involved, if any"),
    query: z.string().optional().describe("Search query, if relevant"),
    trigger: z.string().optional().describe("What triggered this event"),
    raw: z.any().optional().describe("Arbitrary data for future analysis"),
  },
  async ({ type, file, query, trigger, raw }) => {
    ensureDirectories();

    const signal: Signal = {
      timestamp: new Date().toISOString(),
      type,
    };

    if (file || query || trigger) {
      signal.context = {
        ...(file && { file }),
        ...(query && { query }),
        ...(trigger && { trigger }),
      };
    }

    if (raw !== undefined) {
      signal.raw = raw;
    }

    const today = new Date().toISOString().split("T")[0];
    const signalPath = join(getSignalsDir(), `${today}.jsonl`);
    appendFileSync(signalPath, JSON.stringify(signal) + "\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `Logged signal: ${type}`,
        },
      ],
    };
  }
);

// Tool: search_memory
server.tool(
  "search_memory",
  "Semantic search across journal entries and entity files. Returns ranked results.",
  {
    query: z.string().describe("Natural language search query"),
    type: z.enum(["journal", "person", "project", "all"]).default("all").describe("Filter by content type"),
    since: z.string().optional().describe("Only include items after this ISO date"),
    limit: z.number().default(5).describe("Maximum results to return"),
  },
  async ({ query, type, since, limit }) => {
    try {
      const results = await doSearchMemory(query, {
        limit,
        type: type === "all" ? undefined : (type as MemoryItemType),
        since,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "(no matches found)",
            },
          ],
        };
      }

      const formatted = results
        .map((r, i) => {
          const header = `[${i + 1}] ${r.type}${r.section ? ` / ${r.section}` : ""} (score: ${r.score.toFixed(3)})`;
          const meta = r.timestamp ? `  Date: ${r.timestamp}` : "";
          const source = `  Source: ${r.source}`;
          const content = r.content.slice(0, 500) + (r.content.length > 500 ? "..." : "");
          return [header, meta, source, "", content].filter(Boolean).join("\n");
        })
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: formatted,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Search error: ${err}`,
          },
        ],
      };
    }
  }
);

// Tool: rebuild_memory_index
server.tool(
  "rebuild_memory_index",
  "Rebuild the semantic search index from scratch. Use if index seems stale or corrupted.",
  {},
  async () => {
    try {
      const result = await rebuildIndex();
      return {
        content: [
          {
            type: "text" as const,
            text: `Index rebuilt successfully. Indexed ${result.itemCount} items.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to rebuild index: ${err}`,
          },
        ],
      };
    }
  }
);

// Tool: get_memory_index_stats
server.tool("get_memory_index_stats", "Get statistics about the memory index", {}, async () => {
  try {
    const stats = await getIndexStats();
    return {
      content: [
        {
          type: "text" as const,
          text: `Index contains ${stats.itemCount} items.`,
        },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to get index stats: ${err}`,
        },
      ],
    };
  }
});

// Tool: schedule_reminder
server.tool(
  "schedule_reminder",
  "Create a recurring reminder using cron syntax. The daemon will trigger Claude Code when it fires.",
  {
    id: z.string().describe("Unique identifier for this reminder"),
    cronExpression: z.string().describe("Cron expression (e.g., '0 9 * * *' for 9am daily)"),
    description: z.string().describe("What this reminder is for"),
    payload: z.string().describe("Message to process when reminder fires"),
    model: z.string().optional().describe("Model to use (e.g., 'anthropic/claude-opus-4-5' for deep thinking tasks)"),
  },
  async ({ id, cronExpression, description, payload, model }) => {
    const schedule: Schedule = {
      id,
      type: "cron",
      expression: cronExpression,
      description,
      payload,
      agent: "claude", // Hard-coded: MCP server = Claude Code
      model,
      createdAt: new Date().toISOString(),
    };

    const store = loadSchedules();
    store.schedules = store.schedules.filter((s) => s.id !== id);
    store.schedules.push(schedule);
    saveSchedules(store);

    // Note: The daemon will pick up the new schedule on its next check

    return {
      content: [
        {
          type: "text" as const,
          text: `Created recurring reminder: ${id} (${cronExpression})${model ? ` with model ${model}` : ""}`,
        },
      ],
    };
  }
);

// Tool: schedule_once
server.tool(
  "schedule_once",
  "Create a one-shot reminder at a specific datetime. The daemon will trigger Claude Code when it fires.",
  {
    id: z.string().describe("Unique identifier for this reminder"),
    datetime: z.string().describe("ISO 8601 datetime (e.g., '2026-01-31T10:00:00')"),
    description: z.string().describe("What this reminder is for"),
    payload: z.string().describe("Message to process when reminder fires"),
    model: z.string().optional().describe("Model to use (e.g., 'anthropic/claude-opus-4-5' for deep thinking tasks)"),
  },
  async ({ id, datetime, description, payload, model }) => {
    const schedule: Schedule = {
      id,
      type: "once",
      expression: datetime,
      description,
      payload,
      agent: "claude", // Hard-coded: MCP server = Claude Code
      model,
      createdAt: new Date().toISOString(),
    };

    const store = loadSchedules();
    store.schedules = store.schedules.filter((s) => s.id !== id);
    store.schedules.push(schedule);
    saveSchedules(store);

    return {
      content: [
        {
          type: "text" as const,
          text: `Scheduled one-shot reminder: ${id} at ${datetime}${model ? ` with model ${model}` : ""}`,
        },
      ],
    };
  }
);

// Tool: list_reminders
server.tool("list_reminders", "List all active scheduled reminders", {}, async () => {
  const store = loadSchedules();

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(store.schedules, null, 2),
      },
    ],
  };
});

// Tool: remove_reminder
server.tool(
  "remove_reminder",
  "Remove a scheduled reminder",
  {
    id: z.string().describe("ID of the reminder to remove"),
  },
  async ({ id }) => {
    const store = loadSchedules();
    const before = store.schedules.length;
    store.schedules = store.schedules.filter((s) => s.id !== id);
    const removed = before > store.schedules.length;
    saveSchedules(store);

    return {
      content: [
        {
          type: "text" as const,
          text: removed ? `Removed reminder: ${id}` : `Reminder not found: ${id}`,
        },
      ],
    };
  }
);

// Tool: save_conversation_summary
server.tool(
  "save_conversation_summary",
  "Save a summary of the current conversation for context recovery in future sessions",
  {
    summary: z.string().describe("Brief summary of what was discussed/accomplished"),
    keyDecisions: z.array(z.string()).optional().describe("Important decisions made"),
    openThreads: z.array(z.string()).optional().describe("Topics to follow up on"),
    learnedPatterns: z.array(z.string()).optional().describe("New patterns learned about the user"),
    notes: z.string().optional().describe("Freeform notes"),
  },
  async ({ summary, keyDecisions, openThreads, learnedPatterns, notes }) => {
    ensureDirectories();

    const parts = [summary];
    if (keyDecisions?.length) parts.push(`Decisions: ${keyDecisions.join(", ")}`);
    if (openThreads?.length) parts.push(`Open threads: ${openThreads.join(", ")}`);
    if (learnedPatterns?.length) parts.push(`Learned: ${learnedPatterns.join(", ")}`);
    if (notes) parts.push(`Notes: ${notes}`);

    const entry: JournalEntry = {
      timestamp: new Date().toISOString(),
      topic: "conversation-summary",
      content: parts.join("\n"),
      metadata: { source: "conversation" },
    };

    const journalPath = getTodayJournalPath();
    appendFileSync(journalPath, JSON.stringify(entry) + "\n");

    // Index for semantic search
    try {
      await indexJournalEntry(entry);
    } catch (err) {
      console.error("[save_conversation_summary] Failed to index:", err);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: "Conversation summary saved.",
        },
      ],
    };
  }
);

// Tool: get_recent_summaries
server.tool(
  "get_recent_summaries",
  "Get recent conversation summaries for context recovery",
  {
    count: z.number().default(7).describe("Number of summaries to retrieve"),
  },
  async ({ count }) => {
    // Get recent journal entries filtered by topic
    let entries = getRecentJournalEntries(count * 3);
    entries = entries.filter(e => e.topic === "conversation-summary").slice(0, count);

    if (entries.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No conversation summaries yet.",
          },
        ],
      };
    }

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(entries, null, 2),
        },
      ],
    };
  }
);

// Tool: search_conversations
server.tool(
  "search_conversations",
  "Search past Claude Code conversations for similar problems/solutions. By default searches current project first, with recent conversations weighted higher.",
  {
    query: z.string().describe("What to search for (e.g., 'fixing TypeScript errors', 'performance optimization')"),
    projectOnly: z.boolean().default(false).describe("Only search current project (default: search all but boost current)"),
    limit: z.number().default(5).describe("Maximum results to return"),
  },
  async ({ query, projectOnly, limit }) => {
    try {
      // Get current project from CWD environment (set by hook)
      const currentProject = process.env.CLAUDE_PROJECT_DIR;
      
      const results = await searchConversations(query, {
        currentProject,
        projectOnly,
        limit,
      });

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No matching conversations found. Try rebuilding the conversation index with rebuild_conversation_index.",
            },
          ],
        };
      }

      // Format results: metadata + user prompt only (not full response)
      const formatted = results.map((r, i) => {
        const date = new Date(r.exchange.timestamp).toLocaleDateString();
        const branch = r.exchange.branch ? ` (${r.exchange.branch})` : "";
        return `[${i + 1}] ${r.exchange.project}${branch} - ${date}
    "${r.exchange.userPrompt.slice(0, 200)}${r.exchange.userPrompt.length > 200 ? "..." : ""}"
    Session: ${r.exchange.sessionId}`;
      }).join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${results.length} relevant conversation(s):\n\n${formatted}\n\nUse expand_conversation to see full context.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Search error: ${err}`,
          },
        ],
      };
    }
  }
);

// Tool: expand_conversation  
server.tool(
  "expand_conversation",
  "Load full context from a past conversation. Use after search_conversations to see the complete exchange.",
  {
    sessionPath: z.string().describe("Session file path from search results"),
    messageUuid: z.string().optional().describe("Specific message UUID to center on"),
    contextMessages: z.number().default(10).describe("Number of messages to include"),
  },
  async ({ sessionPath, messageUuid, contextMessages }) => {
    try {
      // Resolve session path if only ID given
      let fullPath = sessionPath;
      if (!sessionPath.startsWith("/")) {
        // Assume it's a session ID, need to find the file
        // For now, require full path
        return {
          content: [
            {
              type: "text" as const,
              text: "Please provide the full session path from search results.",
            },
          ],
        };
      }

      const result = await expandConversation(fullPath, messageUuid || "", contextMessages);

      const formatted = result.messages.map(m => {
        const prefix = m.role === "user" ? "User" : "Assistant";
        return `**${prefix}**: ${m.content}`;
      }).join("\n\n---\n\n");

      const header = `Project: ${result.project}${result.branch ? ` (${result.branch})` : ""}\n\n`;

      return {
        content: [
          {
            type: "text" as const,
            text: header + formatted,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to expand conversation: ${err}`,
          },
        ],
      };
    }
  }
);

// Tool: rebuild_conversation_index
server.tool(
  "rebuild_conversation_index",
  "Rebuild the conversation search index from Claude Code's log files. Run this to index new conversations.",
  {},
  async () => {
    try {
      const result = await rebuildConversationIndex();
      return {
        content: [
          {
            type: "text" as const,
            text: `Conversation index rebuilt. Indexed ${result.exchangeCount} exchanges.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to rebuild conversation index: ${err}`,
          },
        ],
      };
    }
  }
);

// Tool: get_conversation_index_stats
server.tool(
  "get_conversation_index_stats",
  "Get statistics about the conversation search index",
  {},
  async () => {
    try {
      const stats = await getConversationIndexStats();
      return {
        content: [
          {
            type: "text" as const,
            text: `Conversation index contains ${stats.exchangeCount} exchanges.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Failed to get conversation index stats: ${err}`,
          },
        ],
      };
    }
  }
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
