/**
 * Macrodata Local MCP Server
 *
 * Provides tools for local file-based memory:
 * - log_journal: Append timestamped entries (with auto-indexing)
 * - get_recent_journal: Get recent entries
 * - search_memory: Semantic search using Transformers.js
 * - manage_index: Rebuild or get stats for memory/conversation indexes
 * - schedule: Create cron or one-shot reminders
 * - list_reminders: List active schedules
 * - remove_reminder: Delete a reminder
 * - save_conversation_summary: Save session summaries
 * - get_recent_summaries: Get past summaries
 * - search_conversations: Search past Claude Code sessions
 * - expand_conversation: Load full context from a session
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
  updateConversationIndex,
  getConversationIndexStats,
} from "./conversations.js";
import {
  getStateRoot,
  getStateDir,
  getEntitiesDir,
  getJournalDir,
  getIndexDir,
  getRemindersDir,
} from "./config.js";
import { unlinkSync } from "fs";
import { getRecentJournalEntries, type JournalEntry } from "./journal.js";
import { cronTooFrequent } from "./reminders.js";

/**
 * Filterable search types: "journal" plus the live entities/<subdir> folder
 * names (dot-dirs excluded, matching the indexer). The filesystem is the
 * single source of truth, so the filter cannot drift from what the indexer
 * stores. Recomputed per search_memory call, so a category added mid-session
 * is filterable immediately — no server restart needed.
 */
function entitySubdirs(): string[] {
  try {
    const dir = getEntitiesDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name);
  } catch {
    return [];
  }
}

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string;
  description: string;
  payload: string;
  agent?: "opencode" | "claude"; // Which agent CLI to trigger
  model?: string; // Optional model override (e.g., "anthropic/claude-opus-4-6")
  delivery?: "session" | "headless"; // How a fired job runs (default: session)
  createdAt: string;
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
    getIndexDir(),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}



function loadAllSchedules(): Schedule[] {
  const remindersDir = getRemindersDir();
  const schedules: Schedule[] = [];

  try {
    if (!existsSync(remindersDir)) return schedules;
    
    const files = readdirSync(remindersDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = readFileSync(join(remindersDir, file), "utf-8");
        schedules.push(JSON.parse(content));
      } catch {
        // Skip malformed files
      }
    }
  } catch {
    // Ignore
  }

  return schedules;
}

function saveSchedule(schedule: Schedule) {
  const remindersDir = getRemindersDir();
  if (!existsSync(remindersDir)) {
    mkdirSync(remindersDir, { recursive: true });
  }
  const filePath = join(remindersDir, `${schedule.id}.json`);
  writeFileSync(filePath, JSON.stringify(schedule, null, 2));
}

function deleteScheduleFile(id: string) {
  const remindersDir = getRemindersDir();
  const filePath = join(remindersDir, `${id}.json`);
  
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
  } catch {
    // Ignore
  }
  return false;
}

function getTodayJournalPath(): string {
  const today = new Date().toISOString().split("T")[0];
  return join(getJournalDir(), `${today}.jsonl`);
}

// Create MCP server
const server = new McpServer({
  name: "macrodata-local",
  version: "0.1.0",
});

// Tool: log_journal
// @ts-expect-error TS2589: deep generic instantiation in the deprecated server.tool() overload (SDK 1.29.0 recommends registerTool); suppressed pending migration to registerTool
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

// Tool: search_memory
server.tool(
  "search_memory",
  "Semantic search across journal entries and entity files. Returns ranked results.",
  {
    query: z.string().describe("Natural language search query"),
    type: z.string().optional().describe("Filter by content type: 'journal' or an entity folder name (people, projects, topics, …). Omit or 'all' for everything."),
    since: z.string().optional().describe("Only include items after this ISO date"),
    limit: z.number().default(5).describe("Maximum results to return"),
  },
  async ({ query, type, since, limit }) => {
    try {
      // Validate against the live folder set rather than a load-time enum, so
      // a category created mid-session is filterable without a restart. Only
      // touch the filesystem when an actual filter is supplied.
      if (type && type !== "all") {
        const validTypes = ["journal", ...entitySubdirs()];
        if (!validTypes.includes(type)) {
          return {
            content: [
              {
                type: "text" as const,
                text: `Unknown type "${type}". Valid: all, ${validTypes.join(", ")}.`,
              },
            ],
          };
        }
      }

      const results = await doSearchMemory(query, {
        limit,
        type: !type || type === "all" ? undefined : (type as MemoryItemType),
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
            text: `Search error: ${String(err)}`,
          },
        ],
      };
    }
  }
);

// Tool: manage_index
// @ts-expect-error TS2589: deep generic instantiation in the deprecated server.tool() overload (SDK 1.29.0 recommends registerTool); suppressed pending migration to registerTool
server.tool(
  "manage_index",
  "Manage search indexes. Target 'memory' for journal/entities, 'conversations' for past Claude Code sessions.",
  {
    target: z.enum(["memory", "conversations"]).describe("Which index to manage"),
    action: z.enum(["rebuild", "update", "stats"]).describe("'rebuild' re-scans all sources and upserts (does NOT purge records for deleted/renamed files — delete the index dir first for a truly clean rebuild), 'update' for incremental (conversations only), 'stats' to get counts"),
  },
  async ({ target, action }) => {
    try {
      if (target === "memory") {
        if (action === "rebuild" || action === "update") {
          const result = await rebuildIndex();
          return {
            content: [{ type: "text" as const, text: `Memory index rebuilt. Indexed ${result.itemCount} items.` }],
          };
        } else {
          const stats = await getIndexStats();
          return {
            content: [{ type: "text" as const, text: `Memory index contains ${stats.itemCount} items.` }],
          };
        }
      } else {
        if (action === "rebuild") {
          // Run in background - don't wait
          rebuildConversationIndex()
            .then((result) => console.log(`[Macrodata] Conversation index rebuilt: ${result.exchangeCount} exchanges`))
            .catch((err) => console.error(`[Macrodata] Conversation index rebuild failed: ${err}`));
          return {
            content: [{ type: "text" as const, text: `Conversation index rebuild started in background.` }],
          };
        } else if (action === "update") {
          // Incremental update - also background
          updateConversationIndex()
            .then((result) => console.log(`[Macrodata] Conversation index updated: ${result.filesUpdated} files (${result.skipped} skipped, total: ${result.exchangeCount})`))
            .catch((err) => console.error(`[Macrodata] Conversation index update failed: ${err}`));
          return {
            content: [{ type: "text" as const, text: `Conversation index update started in background.` }],
          };
        } else {
          const stats = await getConversationIndexStats();
          return {
            content: [{ type: "text" as const, text: `Conversation index contains ${stats.exchangeCount} exchanges.` }],
          };
        }
      }
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Failed to ${action} ${target} index: ${String(err)}` }],
      };
    }
  }
);

// Tool: schedule
// @ts-expect-error TS2589: deep generic instantiation in the deprecated server.tool() overload (SDK 1.29.0 recommends registerTool); suppressed pending migration to registerTool
server.tool(
  "schedule",
  "Create a reminder. Use type 'cron' for recurring (expression is cron syntax) or 'once' for one-shot (expression is ISO datetime).",
  {
    type: z.enum(["cron", "once"]).describe("'cron' for recurring, 'once' for one-shot"),
    // id becomes a filename and an XML attribute when the reminder fires, so
    // constrain it to a safe charset (no path separators, quotes, or glob
    // metacharacters). The daemon re-sanitizes on read for defense in depth.
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "id must be 1-64 chars of [A-Za-z0-9_-]").describe("Unique identifier for this reminder"),
    expression: z.string().describe("Cron expression (e.g., '0 9 * * *') or ISO datetime (e.g., '2026-01-31T10:00:00')"),
    description: z.string().describe("What this reminder is for"),
    payload: z.string().describe("Message to process when reminder fires"),
    // No quotes/spaces/angle brackets — keeps it safe inside the reminder's
    // model="..." attribute; the daemon maps it to a known Agent-tool alias.
    model: z.string().regex(/^[A-Za-z0-9/_.-]{1,64}$/, "model must be 1-64 chars of [A-Za-z0-9/_.-]").optional().describe("Model to use (e.g., 'anthropic/claude-opus-4-6' for deep thinking tasks). Omitting it — or passing an unrecognized value — defaults to haiku."),
    delivery: z.enum(["session", "headless"]).optional().describe("How the fired job runs; pick by intent — both modes are first-class. 'session' (default): queue a reminder drained into your next active session as a background subagent — use when a human should see or act on the result. 'headless': spawn a detached `claude --print` on the tick that runs on schedule with no session open — use when the job should just run on its own. Headless runs unsupervised (and no-ops while the machine is asleep — e.g. a laptop on battery), so give it a payload you trust to run without review — that's a constraint to design around, not a reason to avoid it."),
  },
  async ({ type, id, expression, description, payload, model, delivery }) => {
    // Reject sub-2-minute cron cadences: macrodata has no use for them, and a
    // hot cron on headless delivery is an unbounded spawn-rate hazard (no
    // coalescing). The daemon enforces the same bound for hand-edited JSON.
    if (type === "cron" && cronTooFrequent(expression)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `Rejected: "${expression}" fires more often than every 2 minutes. macrodata cron schedules must be at least 2 minutes apart.`,
          },
        ],
      };
    }

    const schedule: Schedule = {
      id,
      type,
      expression,
      description,
      payload,
      agent: "claude",
      model,
      delivery,
      createdAt: new Date().toISOString(),
    };

    // Save to individual file (overwrites if exists)
    saveSchedule(schedule);

    const typeLabel = type === "cron" ? "recurring" : "one-shot";
    return {
      content: [
        {
          type: "text" as const,
          text: `Created ${typeLabel} reminder: ${id} (${expression})${model ? ` with model ${model}` : ""}`,
        },
      ],
    };
  }
);

// Tool: list_reminders
server.tool("list_reminders", "List all active scheduled reminders", {}, async () => {
  const schedules = loadAllSchedules();

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(schedules, null, 2),
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
    const removed = deleteScheduleFile(id);

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
// @ts-expect-error TS2589: deep generic instantiation in the deprecated server.tool() overload (SDK 1.29.0 recommends registerTool); suppressed pending migration to registerTool
server.tool(
  "save_conversation_summary",
  "Save a summary of the current conversation for context recovery in future sessions",
  {
    summary: z.string().describe("Brief summary of what was discussed/accomplished"),
    keyDecisions: z.array(z.string()).optional().describe("Important decisions made"),
    openThreads: z.array(z.string()).optional().describe("Topics to follow up on"),
    learnedPatterns: z.array(z.string()).optional().describe("New patterns learned about the user"),
    unhelpfulFiles: z
      .array(z.string())
      .optional()
      .describe(
        "Answer this one first, and name specific paths. Memory files loaded at session start or surfaced by recall that did not inform the work — including any that were wrong or superseded. Nothing else in the system can tell a stale file from a live one."
      ),
    helpfulFiles: z
      .array(z.string())
      .optional()
      .describe("Memory files that measurably changed the work this session. Give paths."),
    notes: z.string().optional().describe("Freeform notes"),
  },
  async ({ summary, keyDecisions, openThreads, learnedPatterns, unhelpfulFiles, helpfulFiles, notes }) => {
    ensureDirectories();

    const parts = [summary];
    if (keyDecisions?.length) parts.push(`Decisions: ${keyDecisions.join(", ")}`);
    if (openThreads?.length) parts.push(`Open threads: ${openThreads.join(", ")}`);
    if (learnedPatterns?.length) parts.push(`Learned: ${learnedPatterns.join(", ")}`);
    if (unhelpfulFiles?.length) parts.push(`Unhelpful files: ${unhelpfulFiles.join(", ")}`);
    if (helpfulFiles?.length) parts.push(`Helpful files: ${helpfulFiles.join(", ")}`);
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
// @ts-expect-error TS2589: deep generic instantiation in the deprecated server.tool() overload (SDK 1.29.0 recommends registerTool); suppressed pending migration to registerTool
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
              text: "No matching conversations found. Try manage_index(target: 'conversations', action: 'update').",
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
            text: `Search error: ${String(err)}`,
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
            text: `Failed to expand conversation: ${String(err)}`,
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
