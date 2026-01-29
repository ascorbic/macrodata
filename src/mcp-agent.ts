/**
 * Macrodata MCP Agent
 *
 * The Durable Object that handles MCP tool calls and memory storage.
 * This is separated from the OAuth/routing layer for clarity.
 */

import "./types"; // Extend Env with secrets
import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateText, tool, stepCountIs } from "ai";
import { searchWeb, searchNews } from "./web-search";
import { fetchPageAsMarkdown } from "./web-fetch";
import { createModel, formatModelOptions, embeddingModel } from "./models";

// Connected external MCP
interface ConnectedMcp {
  name: string;
  endpoint: string;
  accessToken: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  connectedAt: string;
}

// State file types
type StateType = "identity" | "today" | "topic" | "project" | "person";

// Database row types
type StateRow = {
  id: string;
  type: string;
  name: string;
  content: string;
  updated_at: string;
};

type JournalRow = {
  id: string;
  topic: string;
  content: string;
  intent: string | null;
  timestamp: string;
};

export class MemoryAgent extends McpAgent<Env> {
  // URLs allowed to be fetched (from search results or user input)
  private allowedUrls: Set<string> = new Set();

  server = new McpServer({
    name: "Macrodata",
    version: "0.3.0",
  });

  /** Initialize SQLite schema */
  private initSchema() {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state_files (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        content TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_state_type ON state_files(type);
      CREATE INDEX IF NOT EXISTS idx_state_type_name ON state_files(type, name);

      CREATE TABLE IF NOT EXISTS journal (
        id TEXT PRIMARY KEY,
        topic TEXT NOT NULL,
        content TEXT NOT NULL,
        intent TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_journal_timestamp ON journal(timestamp);
      CREATE INDEX IF NOT EXISTS idx_journal_topic ON journal(topic);
    `);
  }

  /** Get a state file by type and name */
  private getState(type: StateType, name: string): StateRow | null {
    const result = this.ctx.storage.sql
      .exec<StateRow>(
        "SELECT * FROM state_files WHERE type = ? AND name = ?",
        type,
        name,
      )
      .toArray();
    return result[0] ?? null;
  }

  /** Get all state files of a type */
  private getStatesByType(type: StateType): StateRow[] {
    return this.ctx.storage.sql
      .exec<StateRow>("SELECT * FROM state_files WHERE type = ?", type)
      .toArray();
  }

  /** Save a state file (SQLite + Vectorize) */
  private async saveState(
    type: StateType,
    name: string,
    content: string,
  ): Promise<void> {
    const id = `state-${type}-${name}`;
    const now = new Date().toISOString();

    // Save to SQLite
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO state_files (id, type, name, content, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      type,
      name,
      content,
      now,
    );

    // Sync to Vectorize for semantic search
    const embedding = await this.getEmbedding(`${type} ${name}: ${content}`);
    await this.env.VECTORIZE.upsert([
      {
        id,
        values: embedding,
        metadata: { type, name, content, updatedAt: now },
      },
    ]);
  }

  /** Save a journal entry (SQLite + Vectorize) */
  private async saveJournal(
    topic: string,
    content: string,
    intent?: string,
  ): Promise<string> {
    const id = `journal-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();

    // Save to SQLite
    this.ctx.storage.sql.exec(
      `INSERT INTO journal (id, topic, content, intent, timestamp)
       VALUES (?, ?, ?, ?, ?)`,
      id,
      topic,
      content,
      intent ?? null,
      now,
    );

    // Sync to Vectorize for semantic search
    const embedding = await this.getEmbedding(`${topic}: ${content}`);
    await this.env.VECTORIZE.upsert([
      {
        id,
        values: embedding,
        metadata: {
          type: "journal",
          topic,
          content,
          intent: intent ?? "",
          timestamp: now,
        },
      },
    ]);

    return id;
  }

  /** Get recent journal entries */
  private getRecentJournal(limit: number = 20): JournalRow[] {
    return this.ctx.storage.sql
      .exec<JournalRow>(
        "SELECT * FROM journal ORDER BY timestamp DESC LIMIT ?",
        limit,
      )
      .toArray();
  }

  /** Search memory via Vectorize */
  private async searchMemory(
    query: string,
    options: {
      limit?: number;
      type?: "all" | "journal" | "topic" | "summary";
    } = {},
  ): Promise<
    Array<{
      type: string;
      content: string;
      topic?: string;
      name?: string;
      score: number;
    }>
  > {
    const { limit = 5, type = "all" } = options;
    const embedding = await this.getEmbedding(query);
    const filter = type === "all" ? undefined : { type: { $eq: type } };

    const results = await this.env.VECTORIZE.query(embedding, {
      topK: limit,
      returnMetadata: "all",
      filter,
    });

    return results.matches.map((m) => {
      const meta = m.metadata as Record<string, string>;
      return {
        type: meta.type,
        content: meta.content,
        topic: meta.topic,
        name: meta.name,
        score: m.score,
      };
    });
  }

  /** Get context for sub-agents (identity, user, today) */
  private getAgentContext(): string {
    const identity = this.getState("identity", "identity");
    const user = this.getState("person", "user");
    const today = this.getState("today", "today");

    const parts: string[] = [];
    if (identity) parts.push(`## Identity\n${identity.content}`);
    if (user) parts.push(`## User\n${user.content}`);
    if (today) parts.push(`## Today\n${today.content}`);

    return parts.join("\n\n");
  }

  /** Create tools for sub-agent use with AI SDK */
  private createAgentTools() {
    const self = this;
    return {
      write_state: tool({
        description:
          "Write or update a state file (identity, today, topic, project, person)",
        inputSchema: z.object({
          type: z.enum(["identity", "today", "topic", "project", "person"]),
          name: z.string().describe("State file name"),
          content: z.string().describe("Content to write"),
        }),
        execute: async ({ type, name, content }) => {
          await self.saveState(type as StateType, name, content);
          return `Updated ${type}: ${name}`;
        },
      }),
      read_state: tool({
        description: "Read a state file by type and name",
        inputSchema: z.object({
          type: z.enum(["identity", "today", "topic", "project", "person"]),
          name: z.string().describe("State file name"),
        }),
        execute: async ({ type, name }) => {
          const row = self.getState(type as StateType, name);
          return row ? row.content : `Not found: ${type}/${name}`;
        },
      }),
      log_journal: tool({
        description: "Record an observation, decision, or thing to remember",
        inputSchema: z.object({
          topic: z.string().describe("Short topic/category"),
          content: z.string().describe("The journal entry content"),
        }),
        execute: async ({ topic, content }) => {
          await self.saveJournal(topic, content);
          return `Journal entry saved: ${topic}`;
        },
      }),
      search_memory: tool({
        description: "Search memory using semantic search",
        inputSchema: z.object({
          query: z.string().describe("What to search for"),
          limit: z.number().optional().default(5),
        }),
        execute: async ({ query, limit }) => {
          const results = await self.searchMemory(query, { limit });
          if (results.length === 0) return "No relevant memories found.";
          return results
            .map((r) => `[${r.type}] ${r.topic ?? r.name ?? ""}: ${r.content}`)
            .join("\n\n");
        },
      }),
      list_topics: tool({
        description: "List all topics",
        inputSchema: z.object({}),
        execute: async () => {
          const topics = self.getStatesByType("topic");
          if (topics.length === 0) return "No topics yet.";
          return topics.map((t) => `- ${t.name}`).join("\n");
        },
      }),
      web_search: tool({
        description: "Search the web using Brave Search",
        inputSchema: z.object({
          query: z.string().describe("Search query"),
          count: z.number().optional().default(5),
        }),
        execute: async ({ query, count }) => {
          const apiKey = self.env.BRAVE_SEARCH_API_KEY;
          if (!apiKey) return "Error: BRAVE_SEARCH_API_KEY not configured";
          try {
            const results = await searchWeb(query, apiKey, {
              count: Math.min(count ?? 5, 10),
            });
            if (results.length === 0) return `No results found for "${query}"`;
            return results
              .map((r) => `**${r.title}**\n${r.url}\n${r.description}`)
              .join("\n\n");
          } catch (error) {
            return `Search error: ${error instanceof Error ? error.message : String(error)}`;
          }
        },
      }),
    };
  }

  /** Run an agent task with tool access */
  private async runAgentTask(options: {
    task: string;
    prompt: string;
    model?: string;
    maxSteps?: number;
  }): Promise<string> {
    const { task, prompt, model: modelTier, maxSteps = 10 } = options;

    // Get context for the agent
    const context = this.getAgentContext();
    const systemPrompt = `You are a background agent performing a scheduled task. You have access to tools to read and write memory.

${context}

## Task
${task}

Complete the task using the available tools. Be thorough but concise.`;

    const model = createModel(this.env, modelTier ?? "thinking");
    const tools = this.createAgentTools();

    const { text, steps } = await generateText({
      model,
      system: systemPrompt,
      prompt,
      tools,
      stopWhen: stepCountIs(maxSteps),
    });

    console.log(`[AGENT] Task "${task}" completed in ${steps.length} steps`);
    return text;
  }

  async init() {
    // Initialize database schema
    this.initSchema();
    // ==========================================
    // Core Memory Tools
    // ==========================================

    this.server.tool(
      "log_journal",
      "Record an observation, decision, or thing to remember. Entries are searchable via semantic search.",
      {
        topic: z.string().describe("Short topic/category for the entry"),
        content: z.string().describe("The journal entry content"),
        intent: z.string().optional().describe("Why you're logging this"),
      },
      async ({ topic, content, intent }) => {
        console.log(`[JOURNAL] ${topic}: ${content.slice(0, 50)}...`);
        const id = await this.saveJournal(topic, content, intent);
        console.log(`[JOURNAL] Entry saved with ID: ${id}`);
        return {
          content: [{ type: "text", text: `Journal entry saved: ${topic}` }],
        };
      },
    );

    this.server.tool(
      "search_memory",
      "Search your memory (journal entries, topics, etc.) using semantic search. Returns the most relevant items.",
      {
        query: z.string().describe("What to search for"),
        limit: z
          .number()
          .optional()
          .default(5)
          .describe("Maximum results to return"),
        type: z
          .enum(["all", "journal", "topic", "summary"])
          .optional()
          .default("all")
          .describe("Filter by content type"),
      },
      async ({ query, limit, type }) => {
        console.log(
          `[SEARCH] Query: ${query} (type: ${type}, limit: ${limit})`,
        );
        const embedding = await this.getEmbedding(query);
        const filter = type === "all" ? undefined : { type: { $eq: type } };

        const results = await this.env.VECTORIZE.query(embedding, {
          topK: limit,
          returnMetadata: "all",
          filter,
        });
        console.log(`[SEARCH] Found ${results.matches.length} matches`);
        if (results.matches.length === 0) {
          return {
            content: [{ type: "text", text: "No relevant memories found." }],
          };
        }

        const formatted = results.matches
          .map((m) => {
            const meta = m.metadata as Record<string, string>;
            const score = (m.score * 100).toFixed(0);
            return `[${meta.type}] (${score}% match) ${meta.topic ?? meta.name ?? ""}:\n${meta.content}`;
          })
          .join("\n\n---\n\n");

        return {
          content: [{ type: "text", text: formatted }],
        };
      },
    );

    this.server.tool(
      "get_context",
      "IMPORTANT: Call this at the start of EVERY session to load your identity and state.",
      {},
      async () => {
        // Fetch state from SQLite (deterministic lookups)
        const identityRow = this.getState("identity", "identity");
        const userRow = this.getState("person", "user");
        const todayRow = this.getState("today", "today");
        const recentJournal = this.getRecentJournal(5);
        const schedules = this.getSchedules();

        const identity = identityRow?.content;
        const user = userRow?.content;
        const today = todayRow?.content;

        // Detect first run - no identity means fresh agent
        const isFirstRun = !identity;

        if (isFirstRun) {
          return {
            content: [
              {
                type: "text",
                text: `# First Run - Onboarding Needed

I'm a new agent with no memory. I need to learn about my user before I can help effectively.

## What to Learn

Get to know the user through conversation. Some useful things to understand:
- What they do and what they're working on
- Links to their site, GitHub, LinkedIn, etc. (use \`fetch_page\` to read these and learn more about them)
- How they prefer to communicate (concise vs detailed, formal vs casual)
- Their timezone and typical work schedule (for scheduling reviews)
- What they want help with

Don't interrogate - have a natural conversation. Fetch any links they share to build a richer picture.

## Setup Steps

Once you understand the user:

### 1. Create identity
\`\`\`
write_state(
  type: "identity",
  name: "identity",
  content: "# [Name]\\n\\nI am a stateful agent for [user]. I help with [focus areas].\\n\\n## Communication Style\\n[based on preferences]\\n\\n## Operating Principles\\n- Write state immediately when something happens\\n- Search memory before claiming ignorance\\n- Capture learnings in the moment"
)
\`\`\`

### 2. Create user profile
\`\`\`
write_state(
  type: "person",
  name: "user",
  content: "# [Name]\\n\\n[Bio from their links]\\n\\n## Role\\n[what they do]\\n\\n## Timezone\\n[e.g., Europe/London]\\n\\n## Work Schedule\\n[e.g., 9am-6pm]"
)
\`\`\`

### 3. Set up end-of-day review
\`\`\`
schedule_recurring(
  id: "end-of-day",
  cron: "0 18 * * 1-5",  // 6pm weekdays - adjust to their schedule
  description: "End of day review",
  task: "reflect",
  payload: "Review today's conversations and activity. Identify key learnings, decisions made, and open threads. Update relevant topics. Note anything to follow up on tomorrow.",
  model: "thinking"  // Use thinking tier for deeper reflection
)
\`\`\`

### 4. Set up weekly memory maintenance
\`\`\`
schedule_recurring(
  id: "memory-maintenance",
  cron: "0 3 * * 0",  // Sunday 3am
  description: "Weekly memory maintenance",
  task: "cleanup",
  payload: "Review all topics and journal entries from the past week. Consolidate related learnings. Prune outdated information. Identify patterns worth preserving as new topics.",
  model: "thinking"  // Use thinking tier for analysis
)
\`\`\`

Then you're ready to help.`,
              },
            ],
          };
        }

        // Normal context response
        const recent = recentJournal
          .map((j) => `- [${j.topic}] ${j.content}`)
          .join("\n");

        const scheduleSummary =
          schedules.length > 0
            ? schedules
                .map((s) => {
                  const payload = s.payload as { description?: string };
                  return `- ${payload?.description ?? s.id}`;
                })
                .join("\n")
            : "No schedules configured.";

        return {
          content: [
            {
              type: "text",
              text: `## Identity\n${identity}\n\n## User\n${user ?? "No user profile yet."}\n\n## Today\n${today ?? "No focus set for today."}\n\n## Recent Activity\n${recent || "No recent entries."}\n\n## Active Schedules\n${scheduleSummary}`,
            },
          ],
        };
      },
    );

    // ==========================================
    // State File Tools
    // ==========================================

    this.server.tool(
      "write_state",
      "Write or update a state file (identity, today, topic, etc.). State files are mutable documents that represent your current understanding.",
      {
        name: z
          .string()
          .describe(
            "State file name (e.g., 'identity', 'today', 'topic/nextjs')",
          ),
        content: z.string().describe("The content to write"),
        type: z
          .enum(["identity", "today", "topic", "project", "person"])
          .describe("Type of state file"),
      },
      async ({ name, content, type }) => {
        await this.saveState(type, name, content);
        return {
          content: [{ type: "text", text: `Updated ${type}: ${name}` }],
        };
      },
    );

    this.server.tool(
      "read_state",
      "Read a state file by name and type.",
      {
        name: z.string().describe("State file name"),
        type: z
          .enum(["identity", "today", "topic", "project", "person"])
          .describe("Type of state file"),
      },
      async ({ name, type }) => {
        const row = this.getState(type, name);

        if (!row) {
          return {
            content: [
              { type: "text", text: `State file not found: ${type}/${name}` },
            ],
          };
        }

        return {
          content: [{ type: "text", text: `# ${row.name}\n\n${row.content}` }],
        };
      },
    );

    this.server.tool(
      "list_topics",
      "List all topics (your distilled knowledge).",
      {},
      async () => {
        const topics = this.getStatesByType("topic");

        if (topics.length === 0) {
          return { content: [{ type: "text", text: "No topics yet." }] };
        }

        const formatted = topics.map((t) => `- ${t.name}`).join("\n");

        return {
          content: [{ type: "text", text: `## Topics\n\n${formatted}` }],
        };
      },
    );

    // ==========================================
    // Session Tools
    // ==========================================

    this.server.tool(
      "save_conversation_summary",
      "Save a summary of the current conversation for context recovery in future sessions.",
      {
        summary: z
          .string()
          .describe("Brief summary of what was discussed/accomplished"),
        keyDecisions: z
          .array(z.string())
          .optional()
          .describe("Important decisions made"),
        openThreads: z
          .array(z.string())
          .optional()
          .describe("Topics to follow up on"),
        learnedPatterns: z
          .array(z.string())
          .optional()
          .describe("New patterns learned about the user"),
      },
      async ({ summary, keyDecisions, openThreads, learnedPatterns }) => {
        const id = `summary-${new Date().toISOString().slice(0, 10)}-${Date.now()}`;
        const content = [
          summary,
          keyDecisions?.length ? `\nDecisions: ${keyDecisions.join(", ")}` : "",
          openThreads?.length
            ? `\nOpen threads: ${openThreads.join(", ")}`
            : "",
          learnedPatterns?.length
            ? `\nLearned: ${learnedPatterns.join(", ")}`
            : "",
        ].join("");

        const embedding = await this.getEmbedding(content);

        await this.env.VECTORIZE.upsert([
          {
            id,
            values: embedding,
            metadata: {
              type: "summary",
              content,
              summary,
              keyDecisions: JSON.stringify(keyDecisions ?? []),
              openThreads: JSON.stringify(openThreads ?? []),
              learnedPatterns: JSON.stringify(learnedPatterns ?? []),
              timestamp: new Date().toISOString(),
            },
          },
        ]);

        return {
          content: [{ type: "text", text: "Conversation summary saved." }],
        };
      },
    );

    // ==========================================
    // Web Tools
    // ==========================================

    this.server.tool(
      "web_search",
      "Search the web for current information using Brave Search.",
      {
        query: z.string().describe("Search query"),
        count: z
          .number()
          .optional()
          .default(5)
          .describe("Number of results (max 10)"),
      },
      async ({ query, count }) => {
        const apiKey = this.env.BRAVE_SEARCH_API_KEY;
        if (!apiKey) {
          return {
            content: [
              {
                type: "text",
                text: "Error: BRAVE_SEARCH_API_KEY not configured",
              },
            ],
          };
        }

        try {
          const results = await searchWeb(query, apiKey, {
            count: Math.min(count, 10),
          });

          if (results.length === 0) {
            return {
              content: [
                { type: "text", text: `No results found for "${query}"` },
              ],
            };
          }

          for (const r of results) {
            this.allowedUrls.add(r.url);
          }

          const formatted = results
            .map(
              (r) =>
                `**${r.title}**\n${r.url}\n${r.description}${r.age ? ` (${r.age})` : ""}`,
            )
            .join("\n\n");

          return { content: [{ type: "text", text: formatted }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Search error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );

    this.server.tool(
      "news_search",
      "Search for recent news articles using Brave Search.",
      {
        query: z.string().describe("Search query"),
        count: z
          .number()
          .optional()
          .default(5)
          .describe("Number of results (max 10)"),
      },
      async ({ query, count }) => {
        const apiKey = this.env.BRAVE_SEARCH_API_KEY;
        if (!apiKey) {
          return {
            content: [
              {
                type: "text",
                text: "Error: BRAVE_SEARCH_API_KEY not configured",
              },
            ],
          };
        }

        try {
          const results = await searchNews(query, apiKey, {
            count: Math.min(count, 10),
          });

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No news found for "${query}"` }],
            };
          }

          for (const r of results) {
            this.allowedUrls.add(r.url);
          }

          const formatted = results
            .map(
              (r) =>
                `**${r.title}**\n${r.url}\n${r.description}${r.age ? ` (${r.age})` : ""}`,
            )
            .join("\n\n");

          return { content: [{ type: "text", text: formatted }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `News search error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );

    this.server.tool(
      "fetch_page",
      "Fetch a webpage and convert to markdown. Only works for URLs from search results.",
      {
        url: z.string().url().describe("URL to fetch"),
        waitForJs: z
          .boolean()
          .optional()
          .default(false)
          .describe("Wait for JavaScript to execute"),
      },
      async ({ url, waitForJs }) => {
        if (!this.allowedUrls.has(url)) {
          return {
            content: [
              {
                type: "text",
                text: `URL not allowed. URLs must come from search results. Use web_search first.`,
              },
            ],
          };
        }

        const apiToken = this.env.CF_API_TOKEN;
        const accountId = this.env.CF_ACCOUNT_ID;
        if (!apiToken || !accountId) {
          return {
            content: [
              {
                type: "text",
                text: "Error: CF_API_TOKEN or CF_ACCOUNT_ID not configured",
              },
            ],
          };
        }

        try {
          const markdown = await fetchPageAsMarkdown(url, accountId, apiToken, {
            waitUntil: waitForJs ? "networkidle0" : undefined,
          });

          const maxLength = 50000;
          if (markdown.length > maxLength) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    markdown.slice(0, maxLength) + "\n\n[Content truncated...]",
                },
              ],
            };
          }

          return { content: [{ type: "text", text: markdown }] };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Fetch error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );

    // ==========================================
    // Refine Tool - Cloud Agent Deep Processing
    // ==========================================

    this.server.tool(
      "refine",
      "Ask the cloud agent to do deep processing on your memory - consolidation, pattern recognition, cleanup. The agent has tool access and can make changes.",
      {
        task: z
          .enum(["consolidate", "reflect", "cleanup", "research"])
          .describe("What kind of refinement to do"),
        focus: z.string().optional().describe("Specific area to focus on"),
      },
      async ({ task, focus }) => {
        const taskDescriptions: Record<string, string> = {
          consolidate:
            "Review recent journal entries and consolidate them into updated topics. Look for patterns, recurring themes, and knowledge worth preserving. Create or update topic files as needed.",
          reflect:
            "Reflect on recent activity and identify insights, patterns, or things worth remembering. Log important observations to journal and update relevant topics.",
          cleanup:
            "Review memory for stale, outdated, or redundant entries. Update or remove outdated information from topics. Keep things current.",
          research:
            "Research and gather information using web search. Save findings to relevant topics or journal.",
        };

        const prompt = focus
          ? `${taskDescriptions[task]}\n\nFocus area: ${focus}`
          : taskDescriptions[task];

        try {
          const result = await this.runAgentTask({
            task: `refine:${task}`,
            prompt,
            model: "thinking",
          });

          return {
            content: [
              { type: "text", text: `## Refinement: ${task}\n\n${result}` },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Refinement error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );

    // ==========================================
    // Scheduling Tools
    // ==========================================

    const modelOptions = formatModelOptions();

    this.server.tool(
      "schedule_recurring",
      `Schedule a recurring task using a cron expression. Examples: '0 9 * * 1-5' (9am weekdays), '0 18 * * *' (6pm daily), '0 3 * * 0' (3am Sunday).\n\n${modelOptions}`,
      {
        id: z.string().describe("Unique identifier for this schedule"),
        cron: z
          .string()
          .describe("Cron expression (minute hour day month weekday)"),
        description: z.string().describe("What this schedule does"),
        task: z
          .enum(["consolidate", "reflect", "cleanup", "briefing", "custom"])
          .describe("Type of task to run"),
        payload: z
          .string()
          .optional()
          .describe("Custom instructions for the task"),
        model: z
          .enum(["fast", "thinking", "local"])
          .optional()
          .describe(
            "Model tier: 'fast' (quick), 'thinking' (deep reasoning), 'local' (free). Defaults based on task type.",
          ),
      },
      async ({ id, cron, description, task, payload, model }) => {
        await this.schedule(cron, "runScheduledTask", {
          id,
          task,
          description,
          payload: payload ?? description,
          model,
        });

        return {
          content: [
            {
              type: "text",
              text: `Scheduled recurring task "${description}" with cron: ${cron}`,
            },
          ],
        };
      },
    );

    this.server.tool(
      "schedule_once",
      `Schedule a one-time task at a specific date/time.\n\n${modelOptions}`,
      {
        id: z.string().describe("Unique identifier for this schedule"),
        datetime: z
          .string()
          .describe("ISO 8601 datetime (e.g., '2025-01-23T10:00:00')"),
        description: z.string().describe("What this task does"),
        task: z
          .enum(["consolidate", "reflect", "cleanup", "briefing", "custom"])
          .describe("Type of task to run"),
        payload: z
          .string()
          .optional()
          .describe("Custom instructions for the task"),
        model: z
          .enum(["fast", "thinking", "local"])
          .optional()
          .describe(
            "Model tier: 'fast' (quick), 'thinking' (deep reasoning), 'local' (free). Defaults based on task type.",
          ),
      },
      async ({ id, datetime, description, task, payload, model }) => {
        const date = new Date(datetime);
        await this.schedule(date, "runScheduledTask", {
          id,
          task,
          description,
          payload: payload ?? description,
          model,
        });

        return {
          content: [
            {
              type: "text",
              text: `Scheduled one-time task "${description}" for ${date.toISOString()}`,
            },
          ],
        };
      },
    );

    this.server.tool(
      "list_schedules",
      "List all scheduled tasks.",
      {},
      async () => {
        const schedules = this.getSchedules();

        if (schedules.length === 0) {
          return {
            content: [{ type: "text", text: "No scheduled tasks." }],
          };
        }

        const formatted = schedules
          .map((s) => {
            const payload = s.payload as {
              description?: string;
              task?: string;
            };
            const desc = payload?.description ?? payload?.task ?? "Unknown";
            // s.time is Unix timestamp in seconds, convert to ms for Date
            const timeMs = s.time ? s.time * 1000 : 0;
            const typeInfo =
              s.type === "cron"
                ? `cron: ${s.cron}`
                : `once: ${new Date(timeMs).toISOString()}`;
            return `- **${s.id}**: ${desc}\n  ${typeInfo}\n  Next: ${timeMs ? new Date(timeMs).toISOString() : "N/A"}`;
          })
          .join("\n\n");

        return {
          content: [
            { type: "text", text: `## Scheduled Tasks\n\n${formatted}` },
          ],
        };
      },
    );

    this.server.tool(
      "cancel_schedule",
      "Cancel a scheduled task by ID.",
      {
        id: z.string().describe("ID of the schedule to cancel"),
      },
      async ({ id }) => {
        await this.cancelSchedule(id);

        return {
          content: [{ type: "text", text: `Cancelled schedule: ${id}` }],
        };
      },
    );

    // ==========================================
    // External MCP Tools
    // ==========================================

    this.server.tool(
      "list_external_mcps",
      "List all connected external MCP servers.",
      {},
      async () => {
        const mcps = await this.getConnectedMcps();

        if (mcps.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No external MCPs connected. Add them at /settings/mcps",
              },
            ],
          };
        }

        const formatted = mcps
          .map((m) => `- **${m.name}**: ${m.endpoint}`)
          .join("\n");
        return {
          content: [
            { type: "text", text: `## Connected MCPs\n\n${formatted}` },
          ],
        };
      },
    );

    this.server.tool(
      "list_external_tools",
      "List available tools from an external MCP server.",
      {
        mcpName: z.string().describe("Name of the connected MCP"),
      },
      async ({ mcpName }) => {
        const mcps = await this.getConnectedMcps();
        const mcp = mcps.find((m) => m.name === mcpName);

        if (!mcp) {
          return {
            content: [
              {
                type: "text",
                text: `MCP "${mcpName}" not found. Use list_external_mcps to see available MCPs.`,
              },
            ],
          };
        }

        try {
          const tools = await this.fetchMcpTools(mcp);
          if (tools.length === 0) {
            return {
              content: [
                { type: "text", text: `No tools available from ${mcpName}.` },
              ],
            };
          }

          const formatted = tools
            .map(
              (t) => `- **${t.name}**: ${t.description || "(no description)"}`,
            )
            .join("\n");

          return {
            content: [
              {
                type: "text",
                text: `## Tools from ${mcpName}\n\n${formatted}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error fetching tools from ${mcpName}: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );

    this.server.tool(
      "call_external_tool",
      "Call a tool on an external MCP server.",
      {
        mcpName: z.string().describe("Name of the connected MCP"),
        toolName: z.string().describe("Name of the tool to call"),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments to pass to the tool"),
      },
      async ({ mcpName, toolName, args }) => {
        const mcps = await this.getConnectedMcps();
        const mcp = mcps.find((m) => m.name === mcpName);

        if (!mcp) {
          return {
            content: [
              {
                type: "text",
                text: `MCP "${mcpName}" not found. Use list_external_mcps to see available MCPs.`,
              },
            ],
          };
        }

        try {
          const result = await this.callMcpTool(mcp, toolName, args ?? {});
          return {
            content: [{ type: "text", text: result }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error calling ${toolName} on ${mcpName}: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
          };
        }
      },
    );
  }

  // ==========================================
  // Scheduled Task Handler
  // ==========================================

  async runScheduledTask(data: {
    id?: string;
    task: string;
    description?: string;
    payload?: string;
    focus?: string;
    model?: string;
  }) {
    console.log(`[SCHEDULED] Running task: ${data.description ?? data.task}`);

    // Build task-specific prompts
    const taskPrompts: Record<string, string> = {
      consolidate:
        "Review recent journal entries and consolidate learnings into updated topics. Use search_memory to find relevant entries, then use write_state to update or create topics. Identify patterns and knowledge worth preserving.",
      reflect:
        "Reflect on recent activity and identify insights, patterns, or things worth remembering. Search memory for recent entries, log important observations to journal, and update relevant topics.",
      cleanup:
        "Review memory for stale, outdated, or redundant entries. Search for old topics, check if they're still accurate, and update or consolidate as needed. Keep the knowledge base current.",
      briefing:
        "Prepare a briefing of what's important and what needs attention. Search memory for recent activity, priorities, and open threads. Summarize key points.",
      custom:
        data.payload ?? "Execute the scheduled task using available tools.",
    };

    const basePrompt = taskPrompts[data.task] ?? taskPrompts.custom;
    const prompt =
      data.payload && data.task !== "custom"
        ? `${basePrompt}\n\nAdditional instructions: ${data.payload}`
        : basePrompt;

    // Select model tier
    const needsThinking = ["reflect", "cleanup", "consolidate"].includes(
      data.task,
    );
    const modelTier = data.model ?? (needsThinking ? "thinking" : "fast");

    try {
      const result = await this.runAgentTask({
        task: `scheduled:${data.task}`,
        prompt,
        model: modelTier,
        maxSteps: 15, // Allow more steps for scheduled tasks
      });

      // Log the completion to journal
      await this.saveJournal(
        `scheduled-${data.task}`,
        `Completed scheduled task: ${data.description ?? data.task}\n\nSummary: ${result.slice(0, 500)}`,
      );

      console.log(
        `[SCHEDULED] Task complete: ${data.description ?? data.task}`,
      );
    } catch (error) {
      console.error(`[SCHEDULED] Task failed: ${error}`);
      // Log the failure
      await this.saveJournal(
        `scheduled-${data.task}-error`,
        `Scheduled task failed: ${data.description ?? data.task}\n\nError: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // ==========================================
  // Helper Methods
  // ==========================================

  private async getEmbedding(text: string): Promise<number[]> {
    const result = await this.env.AI.run(embeddingModel, { text: [text] });
    if ("data" in result && result.data && result.data.length > 0) {
      return result.data[0];
    }
    throw new Error("Failed to generate embedding");
  }

  // ==========================================
  // External MCP Methods
  // ==========================================

  /** Get the user ID from the DO name (sessionId = userId) */
  private getUserId(): string {
    // The DO name/id is the userId (set via sessionId in the serve call)
    return this.ctx.id.toString();
  }

  /** Get connected MCPs for this user from KV */
  private async getConnectedMcps(): Promise<ConnectedMcp[]> {
    const userId = this.getUserId();
    const mcpsJson = await this.env.OAUTH_KV?.get(`user:${userId}:mcps`);
    return mcpsJson ? JSON.parse(mcpsJson) : [];
  }

  /** Fetch tools list from an external MCP (via HTTP/SSE) */
  private async fetchMcpTools(
    mcp: ConnectedMcp,
  ): Promise<Array<{ name: string; description?: string }>> {
    // MCP over HTTP - call tools/list
    const response = await fetch(new URL("/mcp", mcp.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mcp.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = (await response.json()) as {
      result?: { tools: Array<{ name: string; description?: string }> };
      error?: { message: string };
    };

    if (result.error) {
      throw new Error(result.error.message);
    }

    return result.result?.tools ?? [];
  }

  /** Call a tool on an external MCP */
  private async callMcpTool(
    mcp: ConnectedMcp,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const response = await fetch(new URL("/mcp", mcp.endpoint), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${mcp.accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const result = (await response.json()) as {
      result?: { content: Array<{ type: string; text?: string }> };
      error?: { message: string };
    };

    if (result.error) {
      throw new Error(result.error.message);
    }

    // Extract text content from the result
    const textContent = result.result?.content
      ?.filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");

    return textContent || "Tool returned no text content.";
  }
}
