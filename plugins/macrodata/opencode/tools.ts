/**
 * Macrodata tools for OpenCode
 *
 * Separate tools for memory operations
 */

import { tool } from "@opencode-ai/plugin";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import { getRemindersDir } from "../src/config.js";
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
import { logger } from "./logger.js";

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string;
  description: string;
  payload: string;
  agent?: "opencode" | "claude";
  model?: string;
  createdAt: string;
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

function saveSchedule(schedule: Schedule): void {
  const remindersDir = getRemindersDir();
  if (!existsSync(remindersDir)) {
    mkdirSync(remindersDir, { recursive: true });
  }
  const filePath = join(remindersDir, `${schedule.id}.json`);
  writeFileSync(filePath, JSON.stringify(schedule, null, 2));
}

function deleteScheduleFile(id: string): boolean {
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

// --- Journal Tools ---

export const logJournalTool = tool({
  description: "Write a journal entry. Use this to record observations, decisions, or things to remember.",
  args: {
    topic: tool.schema.string().describe("Short topic/category for the entry"),
    content: tool.schema.string().describe("The journal entry content"),
    agentIntent: tool.schema.string().optional().describe("Optional: why you're logging this"),
  },
  async execute(args) {
    if (!args.topic || !args.content) {
      return JSON.stringify({ success: false, error: "Requires 'topic' and 'content'" });
    }

    await logJournal(args.topic, args.content, {
      source: "opencode-tool",
      intent: args.agentIntent,
    });

    return JSON.stringify({ success: true, message: `Logged to journal: ${args.topic}` });
  },
});

export const getRecentJournalTool = tool({
  description: "Retrieve recent journal entries for context",
  args: {
    count: tool.schema.number().optional().describe("Number of entries to retrieve (default: 40)"),
  },
  async execute(args) {
    const entries = getRecentJournal(args.count || 40);
    return JSON.stringify({ success: true, entries });
  },
});

// --- Summary Tools ---

export const saveConversationSummaryTool = tool({
  description: "Save a summary of the current conversation for context recovery in future sessions",
  args: {
    summary: tool.schema.string().describe("Brief summary of what was discussed/accomplished"),
    keyDecisions: tool.schema.array(tool.schema.string()).optional().describe("Important decisions made"),
    openThreads: tool.schema.array(tool.schema.string()).optional().describe("Topics to follow up on"),
    learnedPatterns: tool.schema.array(tool.schema.string()).optional().describe("New patterns learned about the user"),
    notes: tool.schema.string().optional().describe("Freeform notes for anything that doesn't fit structured fields"),
  },
  async execute(args) {
    if (!args.summary) {
      return JSON.stringify({ success: false, error: "Requires 'summary'" });
    }

    await saveConversationSummary({
      summary: args.summary,
      keyDecisions: args.keyDecisions,
      openThreads: args.openThreads,
      learnedPatterns: args.learnedPatterns,
      notes: args.notes,
    });

    return JSON.stringify({ success: true, message: "Conversation summary saved" });
  },
});

export const getRecentSummariesTool = tool({
  description: "Get recent conversation summaries for context recovery",
  args: {
    count: tool.schema.number().optional().describe("Number of summaries to retrieve (default: 7)"),
  },
  async execute(args) {
    const summaries = getRecentSummaries(args.count || 7);
    return JSON.stringify({ success: true, summaries });
  },
});

// --- Search Tools ---

export const searchMemoryTool = tool({
  description: "Semantic search over your history - journal, state files, projects, people. Use to find relevant context.",
  args: {
    query: tool.schema.string().describe("Natural language query to search for"),
    type: tool.schema.enum(["journal", "state", "project", "person", "meeting", "topic"]).optional().describe("Filter by content type"),
    limit: tool.schema.number().optional().describe("Maximum results to return (default: 5)"),
    since: tool.schema.string().optional().describe("Only include items after this ISO date"),
  },
  async execute(args) {
    if (!args.query) {
      return JSON.stringify({ success: false, error: "Requires 'query'" });
    }

    const results = await searchMemory(args.query, {
      limit: args.limit || 5,
      type: args.type as any,
      since: args.since,
    });

    if (results.length === 0) {
      return JSON.stringify({
        success: true,
        message: "No matches found. Try rebuilding the index with rebuild_memory_index",
        results: [],
      });
    }

    return JSON.stringify({
      success: true,
      count: results.length,
      results: results.map((r) => ({
        type: r.type,
        source: r.source,
        section: r.section,
        score: Math.round(r.score * 100) / 100,
        content: r.content.slice(0, 500),
      })),
    });
  },
});

export const searchConversationsTool = tool({
  description: "Search past OpenCode sessions",
  args: {
    query: tool.schema.string().describe("Natural language query to search for"),
    projectOnly: tool.schema.boolean().optional().describe("Only search current project"),
    limit: tool.schema.number().optional().describe("Maximum results to return (default: 5)"),
  },
  async execute(args) {
    if (!args.query) {
      return JSON.stringify({ success: false, error: "Requires 'query'" });
    }

    const results = await searchConversations(args.query, {
      currentProject: process.cwd(),
      limit: args.limit || 5,
      projectOnly: args.projectOnly,
    });

    if (results.length === 0) {
      return JSON.stringify({
        success: true,
        message: "No matching conversations. Try rebuilding with rebuild_memory_index",
        results: [],
      });
    }

    return JSON.stringify({
      success: true,
      count: results.length,
      results: results.map((r) => ({
        project: r.exchange.project,
        timestamp: r.exchange.timestamp,
        sessionId: r.exchange.sessionId,
        score: Math.round(r.adjustedScore * 100) / 100,
        userPrompt: r.exchange.userPrompt.slice(0, 200),
        assistantSummary: r.exchange.assistantSummary.slice(0, 200),
      })),
    });
  },
});

// --- Index Tools ---

export const rebuildMemoryIndexTool = tool({
  description: "Rebuild the semantic search index from scratch. Use if index seems stale or corrupted.",
  args: {},
  async execute() {
    // Rebuild memory index synchronously (fast)
    await rebuildMemoryIndex();
    const memoryStats = await getMemoryIndexStats();

    // Rebuild conversation index in background (slow - thousands of exchanges)
    rebuildConversationIndex()
      .then((result) => logger.log(`Conversation index rebuilt: ${result.exchangeCount} exchanges`))
      .catch((err) => logger.error(`Conversation index rebuild failed: ${err}`));

    return JSON.stringify({
      success: true,
      message: "Memory index rebuilt. Conversation index rebuilding in background.",
      stats: {
        memoryItems: memoryStats.itemCount,
      },
    });
  },
});

export const getMemoryIndexStatsTool = tool({
  description: "Get statistics about the memory index",
  args: {},
  async execute() {
    const memoryStats = await getMemoryIndexStats();
    const convStats = await getConversationIndexStats();

    return JSON.stringify({
      success: true,
      memoryItems: memoryStats.itemCount,
      conversationExchanges: convStats.exchangeCount,
    });
  },
});

// --- Reminder Tools ---

export const scheduleReminderTool = tool({
  description: "Schedule a recurring reminder using cron syntax. Examples: '0 9 * * *' = 9am daily, '0 */2 * * *' = every 2 hours. IMPORTANT: Check the current time before using this tool to ensure accurate scheduling.",
  args: {
    id: tool.schema.string().describe("Unique reminder identifier"),
    cronExpression: tool.schema.string().describe("Cron expression (e.g., '0 9 * * *' for 9am daily)"),
    description: tool.schema.string().describe("What this reminder is for"),
    payload: tool.schema.string().describe("Message to process when reminder fires"),
    model: tool.schema.string().optional().describe("Model to use for this reminder (see macrodata-models in context for available options)"),
  },
  async execute(args) {
    if (!args.id || !args.cronExpression || !args.description || !args.payload) {
      return JSON.stringify({ success: false, error: "Requires 'id', 'cronExpression', 'description', and 'payload'" });
    }

    const schedule: Schedule = {
      id: args.id,
      type: "cron",
      expression: args.cronExpression,
      description: args.description,
      payload: args.payload,
      agent: "opencode",
      model: args.model,
      createdAt: new Date().toISOString(),
    };

    saveSchedule(schedule);

    return JSON.stringify({
      success: true,
      message: `Created recurring reminder: ${args.id} (${args.cronExpression})${args.model ? ` with model ${args.model}` : ""}`,
    });
  },
});

export const scheduleOnceTool = tool({
  description: "Schedule a one-shot reminder at a specific date/time. The reminder fires once and is automatically removed. IMPORTANT: Check the current time before using this tool to ensure accurate scheduling.",
  args: {
    id: tool.schema.string().describe("Unique reminder identifier"),
    datetime: tool.schema.string().describe("ISO 8601 datetime (e.g., '2026-01-06T10:00:00')"),
    description: tool.schema.string().describe("What this reminder is for"),
    payload: tool.schema.string().describe("Message to process when reminder fires"),
    model: tool.schema.string().optional().describe("Model to use for this reminder (see macrodata-models in context for available options)"),
  },
  async execute(args) {
    if (!args.id || !args.datetime || !args.description || !args.payload) {
      return JSON.stringify({ success: false, error: "Requires 'id', 'datetime', 'description', and 'payload'" });
    }

    const schedule: Schedule = {
      id: args.id,
      type: "once",
      expression: args.datetime,
      description: args.description,
      payload: args.payload,
      agent: "opencode",
      model: args.model,
      createdAt: new Date().toISOString(),
    };

    saveSchedule(schedule);

    return JSON.stringify({
      success: true,
      message: `Scheduled one-shot reminder: ${args.id} at ${args.datetime}${args.model ? ` with model ${args.model}` : ""}`,
    });
  },
});

export const removeReminderTool = tool({
  description: "Remove a scheduled reminder",
  args: {
    id: tool.schema.string().describe("Reminder ID to remove"),
  },
  async execute(args) {
    if (!args.id) {
      return JSON.stringify({ success: false, error: "Requires 'id'" });
    }

    const removed = deleteScheduleFile(args.id);

    return JSON.stringify({
      success: removed,
      message: removed ? `Removed reminder: ${args.id}` : `Reminder not found: ${args.id}`,
    });
  },
});

export const listRemindersTool = tool({
  description: "List all scheduled reminders",
  args: {},
  async execute() {
    const schedules = loadAllSchedules();
    return JSON.stringify({ success: true, reminders: schedules });
  },
});

// --- Related Items Tool ---

export const getRelatedTool = tool({
  description: "Get entries related to a specific memory item. Useful for exploring associative connections in your memory.",
  args: {
    id: tool.schema.string().describe("The ID of the memory item to find related entries for"),
  },
  async execute(args) {
    if (!args.id) {
      return JSON.stringify({ success: false, error: "Requires 'id'" });
    }

    // TODO: Implement related items lookup
    return JSON.stringify({
      success: true,
      message: "Related items feature not yet implemented",
      related: [],
    });
  },
});

// Export all tools as a collection
export const memoryTools = {
  macrodata_log_journal: logJournalTool,
  macrodata_get_recent_journal: getRecentJournalTool,
  macrodata_save_conversation_summary: saveConversationSummaryTool,
  macrodata_get_recent_summaries: getRecentSummariesTool,
  macrodata_search_memory: searchMemoryTool,
  macrodata_search_conversations: searchConversationsTool,
  macrodata_rebuild_memory_index: rebuildMemoryIndexTool,
  macrodata_get_memory_index_stats: getMemoryIndexStatsTool,
  macrodata_schedule_reminder: scheduleReminderTool,
  macrodata_schedule_once: scheduleOnceTool,
  macrodata_remove_reminder: removeReminderTool,
  macrodata_list_reminders: listRemindersTool,
  macrodata_get_related: getRelatedTool,
};
