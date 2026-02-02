/**
 * Macrodata tool for OpenCode
 *
 * Provides memory operations: journal, search, search_conversations, summary, remind, read, list, rebuild_index
 */

import { tool } from "@opencode-ai/plugin";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { getStateRoot } from "./context.js";
import {
  logJournal,
  getRecentJournal,
  getRecentSummaries,
  saveConversationSummary,
} from "./journal.js";
import {
  searchMemory,
  rebuildMemoryIndex,
  getMemoryIndexStats,
} from "./search.js";
import {
  searchConversations,
  rebuildConversationIndex,
  getConversationIndexStats,
} from "./conversations.js";

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string;
  description: string;
  payload: string;
  model?: string;
  createdAt: string;
}

interface ScheduleStore {
  schedules: Schedule[];
}

function loadSchedules(): ScheduleStore {
  const stateRoot = getStateRoot();
  const schedulesFile = join(stateRoot, ".schedules.json");

  try {
    if (existsSync(schedulesFile)) {
      return JSON.parse(readFileSync(schedulesFile, "utf-8"));
    }
  } catch {
    // Ignore
  }
  return { schedules: [] };
}

function saveSchedules(store: ScheduleStore): void {
  const stateRoot = getStateRoot();
  const schedulesFile = join(stateRoot, ".schedules.json");
  writeFileSync(schedulesFile, JSON.stringify(store, null, 2));
}

export const macrodataTool = tool({
  description: `Persistent memory system for AI agents. Modes:
- journal: Log observations, decisions, learnings
- search: Semantic search over journal and entities
- search_conversations: Search past OpenCode sessions
- summary: Save/get conversation summaries
- remind: Schedule one-shot or recurring reminders
- read: Read a state file
- list: List reminders or recent journal entries
- rebuild_index: Rebuild search indexes`,
  args: {
    mode: tool.schema
      .enum(["journal", "search", "search_conversations", "summary", "remind", "read", "list", "rebuild_index"])
      .describe("Operation to perform"),
    // Journal mode
    topic: tool.schema.string().optional().describe("Topic/category for journal entry"),
    content: tool.schema.string().optional().describe("Content to log or summary text"),
    intent: tool.schema.string().optional().describe("Why you're logging this"),
    // Search mode
    query: tool.schema.string().optional().describe("Search query"),
    searchType: tool.schema.enum(["all", "journal", "person", "project", "topic"]).optional().describe("Filter search by type"),
    since: tool.schema.string().optional().describe("Only include items after this ISO date"),
    // Search conversations mode
    projectOnly: tool.schema.boolean().optional().describe("Only search current project"),
    // Summary mode
    keyDecisions: tool.schema.array(tool.schema.string()).optional().describe("Key decisions made"),
    openThreads: tool.schema.array(tool.schema.string()).optional().describe("Topics to follow up"),
    learnedPatterns: tool.schema.array(tool.schema.string()).optional().describe("Patterns learned"),
    notes: tool.schema.string().optional().describe("Freeform notes"),
    // Remind mode
    id: tool.schema.string().optional().describe("Reminder ID"),
    cronExpression: tool.schema.string().optional().describe("Cron expression for recurring"),
    datetime: tool.schema.string().optional().describe("ISO datetime for one-shot"),
    description: tool.schema.string().optional().describe("Reminder description"),
    payload: tool.schema.string().optional().describe("Message when reminder fires"),
    model: tool.schema.string().optional().describe("Model override for reminder"),
    // Read mode
    file: tool.schema.string().optional().describe("File to read (e.g., 'identity', 'today', 'topics')"),
    // List mode
    listType: tool.schema.enum(["reminders", "journal", "summaries"]).optional().describe("What to list"),
    count: tool.schema.number().optional().describe("Number of items to return"),
  },
  async execute(args) {
    const stateRoot = getStateRoot();

    try {
      switch (args.mode) {
        case "journal": {
          if (!args.topic || !args.content) {
            return JSON.stringify({
              success: false,
              error: "journal mode requires 'topic' and 'content'",
            });
          }

          await logJournal(args.topic, args.content, {
            source: "opencode-tool",
            intent: args.intent,
          });

          return JSON.stringify({
            success: true,
            message: `Logged to journal: ${args.topic}`,
          });
        }

        case "search": {
          if (!args.query) {
            return JSON.stringify({
              success: false,
              error: "search mode requires 'query'",
            });
          }

          const searchResults = await searchMemory(args.query, {
            limit: args.count || 5,
            type: args.searchType === "all" ? undefined : args.searchType,
            since: args.since,
          });

          if (searchResults.length === 0) {
            return JSON.stringify({
              success: true,
              message: "No matches found. Try rebuilding the index with mode: 'rebuild_index'",
              results: [],
            });
          }

          return JSON.stringify({
            success: true,
            count: searchResults.length,
            results: searchResults.map((r) => ({
              type: r.type,
              source: r.source,
              section: r.section,
              score: Math.round(r.score * 100) / 100,
              content: r.content.slice(0, 500),
            })),
          });
        }

        case "search_conversations": {
          if (!args.query) {
            return JSON.stringify({
              success: false,
              error: "search_conversations mode requires 'query'",
            });
          }

          const convResults = await searchConversations(args.query, {
            limit: args.count || 5,
            projectOnly: args.projectOnly,
          });

          if (convResults.length === 0) {
            return JSON.stringify({
              success: true,
              message: "No matching conversations. Try rebuilding with mode: 'rebuild_index'",
              results: [],
            });
          }

          return JSON.stringify({
            success: true,
            count: convResults.length,
            results: convResults.map((r) => ({
              project: r.exchange.project,
              timestamp: r.exchange.timestamp,
              sessionId: r.exchange.sessionId,
              score: Math.round(r.adjustedScore * 100) / 100,
              userPrompt: r.exchange.userPrompt.slice(0, 200),
              assistantSummary: r.exchange.assistantSummary.slice(0, 200),
            })),
          });
        }

        case "summary": {
          if (args.content) {
            // Save summary
            await saveConversationSummary({
              summary: args.content,
              keyDecisions: args.keyDecisions,
              openThreads: args.openThreads,
              learnedPatterns: args.learnedPatterns,
              notes: args.notes,
            });

            return JSON.stringify({
              success: true,
              message: "Conversation summary saved",
            });
          } else {
            // Get recent summaries
            const summaries = getRecentSummaries(args.count || 5);
            return JSON.stringify({
              success: true,
              summaries,
            });
          }
        }

        case "remind": {
          if (!args.id) {
            return JSON.stringify({
              success: false,
              error: "remind mode requires 'id'",
            });
          }

          const store = loadSchedules();

          if (args.cronExpression) {
            // Create recurring reminder
            if (!args.description || !args.payload) {
              return JSON.stringify({
                success: false,
                error: "Recurring reminder requires 'description' and 'payload'",
              });
            }

            const schedule: Schedule = {
              id: args.id,
              type: "cron",
              expression: args.cronExpression,
              description: args.description,
              payload: args.payload,
              model: args.model,
              createdAt: new Date().toISOString(),
            };

            store.schedules = store.schedules.filter((s) => s.id !== args.id);
            store.schedules.push(schedule);
            saveSchedules(store);

            return JSON.stringify({
              success: true,
              message: `Created recurring reminder: ${args.id} (${args.cronExpression})`,
            });
          } else if (args.datetime) {
            // Create one-shot reminder
            if (!args.description || !args.payload) {
              return JSON.stringify({
                success: false,
                error: "One-shot reminder requires 'description' and 'payload'",
              });
            }

            const schedule: Schedule = {
              id: args.id,
              type: "once",
              expression: args.datetime,
              description: args.description,
              payload: args.payload,
              model: args.model,
              createdAt: new Date().toISOString(),
            };

            store.schedules = store.schedules.filter((s) => s.id !== args.id);
            store.schedules.push(schedule);
            saveSchedules(store);

            return JSON.stringify({
              success: true,
              message: `Scheduled one-shot reminder: ${args.id} at ${args.datetime}`,
            });
          } else {
            // Remove reminder
            const before = store.schedules.length;
            store.schedules = store.schedules.filter((s) => s.id !== args.id);
            const removed = before > store.schedules.length;
            saveSchedules(store);

            return JSON.stringify({
              success: removed,
              message: removed
                ? `Removed reminder: ${args.id}`
                : `Reminder not found: ${args.id}`,
            });
          }
        }

        case "read": {
          if (!args.file) {
            return JSON.stringify({
              success: false,
              error: "read mode requires 'file'",
            });
          }

          // Map common names to paths
          const fileMap: Record<string, string> = {
            identity: join(stateRoot, "identity.md"),
            today: join(stateRoot, "state", "today.md"),
            human: join(stateRoot, "state", "human.md"),
            workspace: join(stateRoot, "state", "workspace.md"),
            topics: join(stateRoot, "state", "topics.md"),
          };

          const filePath = fileMap[args.file] || args.file;

          if (!existsSync(filePath)) {
            return JSON.stringify({
              success: false,
              error: `File not found: ${filePath}`,
            });
          }

          const content = readFileSync(filePath, "utf-8");
          return JSON.stringify({
            success: true,
            path: filePath,
            content,
          });
        }

        case "list": {
          const listType = args.listType || "journal";
          const count = args.count || 10;

          if (listType === "reminders") {
            const store = loadSchedules();
            return JSON.stringify({
              success: true,
              reminders: store.schedules,
            });
          } else if (listType === "summaries") {
            const summaries = getRecentSummaries(count);
            return JSON.stringify({
              success: true,
              summaries,
            });
          } else {
            const entries = getRecentJournal(count);
            return JSON.stringify({
              success: true,
              entries,
            });
          }
        }

        case "rebuild_index": {
          const indexType = args.listType || "all";
          const results: Record<string, unknown> = {};

          if (indexType === "all" || indexType === "journal") {
            const memoryResult = await rebuildMemoryIndex();
            results.memory = memoryResult;
          }

          if (indexType === "all" || indexType === "summaries") {
            const convResult = await rebuildConversationIndex();
            results.conversations = convResult;
          }

          // Also get stats
          const memoryStats = await getMemoryIndexStats();
          const convStats = await getConversationIndexStats();

          return JSON.stringify({
            success: true,
            message: "Index rebuilt",
            rebuilt: results,
            stats: {
              memoryItems: memoryStats.itemCount,
              conversationExchanges: convStats.exchangeCount,
            },
          });
        }

        default:
          return JSON.stringify({
            success: false,
            error: `Unknown mode: ${args.mode}`,
          });
      }
    } catch (err) {
      return JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
});
