/**
 * Macrodata MCP Agent
 *
 * The Durable Object that handles MCP tool calls and memory storage.
 * This is separated from the OAuth/routing layer for clarity.
 */

import "./types"; // Extend Env with secrets
import { Agent } from "agents";
import { createMcpHandler, WorkerTransport } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateText, tool, stepCountIs } from "ai";
import { searchWeb, searchNews } from "./web-search";
import { fetchPageAsMarkdown } from "./web-fetch";
import { createModel, formatModelOptions, embeddingModel } from "./models";
import type {
	CoreContextType,
	CoreContextRow,
	KnowledgeRow,
	JournalRow,
	ConnectedMcp,
	McpTool,
	QueryResult,
	MemoryStats,
	StateEvent,
} from "./types";

export class MemoryAgent extends Agent<Env> {
	// MCP server instance - persists across requests, reset on new session
	private mcpServer: McpServer | null = null;
	private mcpTransport: InstanceType<typeof WorkerTransport> | null = null;

	// ==========================================
	// WebSocket Handling (via partyserver)
	// ==========================================

	/** Broadcast an event to all connected WebSocket clients */
	private broadcastEvent(event: StateEvent) {
		const message = JSON.stringify(event);

		// Use partyserver's broadcast method
		try {
			this.broadcast(message);
			console.log(`[WS] Broadcast event: ${event.source}/${event.action}/${event.key}`);
		} catch (err) {
			// No connections, or broadcast not available
			console.log(`[WS] No clients to broadcast to`);
		}
	}

	private createMcpServer(): McpServer {
		const server = new McpServer({
			name: "Macrodata",
			version: "0.4.0",
		});
		this.registerTools(server);
		return server;
	}

	async onMcpRequest(request: Request): Promise<Response> {
		// Check if this is an initialize request (new session)
		const body = (await request.clone().json().catch(() => ({}))) as { method?: string };
		const isInitialize = body.method === "initialize";

		if (isInitialize || !this.mcpServer) {
			// New session - create fresh server and transport
			this.mcpServer = this.createMcpServer();
			this.mcpTransport = new WorkerTransport({
				sessionIdGenerator: () => this.name,
			});
		}

		return createMcpHandler(this.mcpServer, {
			transport: this.mcpTransport!,
		})(request, this.env, {} as ExecutionContext);
	}

	// ==========================================
	// Database Schema & Migration
	// ==========================================

	/** Initialize SQLite schema */
	private initSchema() {
		// Check if we need to migrate from v1 schema
		const hasOldTable = this.ctx.storage.sql
			.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name='state_files'")
			.toArray().length > 0;

		if (hasOldTable) {
			this.migrateFromV1();
		}

		// Create new schema tables
		this.ctx.storage.sql.exec(`
			-- Core context (3 special files: identity, today, human)
			CREATE TABLE IF NOT EXISTS core_context (
				which TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			-- Knowledge (flexible types)
			CREATE TABLE IF NOT EXISTS knowledge (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				name TEXT NOT NULL,
				content TEXT NOT NULL,
				tags TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(type, name)
			);
			CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge(type);
			CREATE INDEX IF NOT EXISTS idx_knowledge_updated ON knowledge(updated_at);

			-- Journal (unchanged)
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

	/** Migrate data from v1 schema (state_files) to v2 (core_context + knowledge) */
	private migrateFromV1() {
		console.log("[MIGRATION] Starting v1 -> v2 migration");

		type OldStateRow = {
			id: string;
			type: string;
			name: string;
			content: string;
			updated_at: string;
		};

		// Get all old state files
		const oldRows = this.ctx.storage.sql.exec<OldStateRow>("SELECT * FROM state_files").toArray();

		// Create new tables first
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS core_context (
				which TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);

			CREATE TABLE IF NOT EXISTS knowledge (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				name TEXT NOT NULL,
				content TEXT NOT NULL,
				tags TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				UNIQUE(type, name)
			);
		`);

		// Migrate data
		for (const row of oldRows) {
			if (row.type === "identity" && row.name === "identity") {
				// identity -> core_context.identity
				this.ctx.storage.sql.exec(
					"INSERT OR REPLACE INTO core_context (which, content, updated_at) VALUES (?, ?, ?)",
					"identity",
					row.content,
					row.updated_at,
				);
			} else if (row.type === "today" && row.name === "today") {
				// today -> core_context.today
				this.ctx.storage.sql.exec(
					"INSERT OR REPLACE INTO core_context (which, content, updated_at) VALUES (?, ?, ?)",
					"today",
					row.content,
					row.updated_at,
				);
			} else if (row.type === "person" && row.name === "user") {
				// person/user -> core_context.human
				this.ctx.storage.sql.exec(
					"INSERT OR REPLACE INTO core_context (which, content, updated_at) VALUES (?, ?, ?)",
					"human",
					row.content,
					row.updated_at,
				);
			} else {
				// Everything else -> knowledge
				const id = `knowledge-${row.type}-${row.name}`;
				this.ctx.storage.sql.exec(
					`INSERT OR REPLACE INTO knowledge (id, type, name, content, tags, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					id,
					row.type,
					row.name,
					row.content,
					null,
					row.updated_at,
					row.updated_at,
				);
			}
		}

		// Drop old table
		this.ctx.storage.sql.exec("DROP TABLE IF EXISTS state_files");
		console.log(`[MIGRATION] Migrated ${oldRows.length} rows from state_files`);
	}

	// ==========================================
	// Core Context Methods
	// ==========================================

	/** Get a core context file */
	getCoreContext(which: CoreContextType): CoreContextRow | null {
		const result = this.ctx.storage.sql
			.exec<CoreContextRow>("SELECT * FROM core_context WHERE which = ?", which)
			.toArray();
		return result[0] ?? null;
	}

	/** Save a core context file */
	async saveCoreContext(which: CoreContextType, content: string): Promise<void> {
		const now = new Date().toISOString();
		const existing = this.getCoreContext(which);

		this.ctx.storage.sql.exec(
			"INSERT OR REPLACE INTO core_context (which, content, updated_at) VALUES (?, ?, ?)",
			which,
			content,
			now,
		);

		// Sync to Vectorize
		const id = `core-${which}`;
		const embedding = await this.getEmbedding(`${which}: ${content}`);
		await this.env.VECTORIZE.upsert([
			{
				id,
				values: embedding,
				metadata: { type: "core", name: which, timestamp: Date.now(), content },
			},
		]);

		// Notify subscribers
		this.broadcastEvent({
			type: "state_changed",
			source: "core",
			action: existing ? "updated" : "created",
			key: which,
			summary: content.slice(0, 100),
			timestamp: now,
		});
	}

	// ==========================================
	// Knowledge Methods
	// ==========================================

	/** Get a knowledge entry by type and name */
	getKnowledge(type: string, name: string): KnowledgeRow | null {
		const result = this.ctx.storage.sql
			.exec<KnowledgeRow>("SELECT * FROM knowledge WHERE type = ? AND name = ?", type, name)
			.toArray();
		return result[0] ?? null;
	}

	/** Get all knowledge of a specific type */
	getKnowledgeByType(type: string): KnowledgeRow[] {
		return this.ctx.storage.sql
			.exec<KnowledgeRow>("SELECT * FROM knowledge WHERE type = ? ORDER BY updated_at DESC", type)
			.toArray();
	}

	/** Get all knowledge entries */
	getAllKnowledge(): KnowledgeRow[] {
		return this.ctx.storage.sql
			.exec<KnowledgeRow>("SELECT * FROM knowledge ORDER BY type, name")
			.toArray();
	}

	/** Save a knowledge entry */
	async saveKnowledge(type: string, name: string, content: string, tags?: string[]): Promise<string> {
		const id = `knowledge-${type}-${name}`;
		const now = new Date().toISOString();
		const existing = this.getKnowledge(type, name);

		this.ctx.storage.sql.exec(
			`INSERT OR REPLACE INTO knowledge (id, type, name, content, tags, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			id,
			type,
			name,
			content,
			tags ? JSON.stringify(tags) : null,
			existing?.created_at ?? now,
			now,
		);

		// Sync to Vectorize
		const embedding = await this.getEmbedding(`${type} ${name}: ${content}`);
		await this.env.VECTORIZE.upsert([
			{
				id,
				values: embedding,
				metadata: { type: "knowledge", subtype: type, name, timestamp: Date.now(), content },
			},
		]);

		// Notify subscribers
		this.broadcastEvent({
			type: "state_changed",
			source: "knowledge",
			action: existing ? "updated" : "created",
			key: `${type}/${name}`,
			summary: content.slice(0, 100),
			timestamp: now,
		});

		return id;
	}

	/** Delete a knowledge entry */
	async deleteKnowledge(type: string, name: string): Promise<boolean> {
		const id = `knowledge-${type}-${name}`;
		const existing = this.getKnowledge(type, name);
		if (!existing) return false;

		this.ctx.storage.sql.exec("DELETE FROM knowledge WHERE type = ? AND name = ?", type, name);
		await this.env.VECTORIZE.deleteByIds([id]);

		// Notify subscribers
		this.broadcastEvent({
			type: "state_changed",
			source: "knowledge",
			action: "deleted",
			key: `${type}/${name}`,
			timestamp: new Date().toISOString(),
		});

		return true;
	}

	// ==========================================
	// Journal Methods
	// ==========================================

	/** Save a journal entry (SQLite + Vectorize) */
	async saveJournal(topic: string, content: string, intent?: string): Promise<string> {
		const id = `journal-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
		const now = new Date().toISOString();

		this.ctx.storage.sql.exec(
			"INSERT INTO journal (id, topic, content, intent, timestamp) VALUES (?, ?, ?, ?, ?)",
			id,
			topic,
			content,
			intent ?? null,
			now,
		);

		// Sync to Vectorize
		const embedding = await this.getEmbedding(`${topic}: ${content}`);
		await this.env.VECTORIZE.upsert([
			{
				id,
				values: embedding,
				metadata: { type: "journal", topic, timestamp: Date.now(), content },
			},
		]);

		// Notify subscribers (skip audit entries to reduce noise)
		if (intent !== "audit") {
			this.broadcastEvent({
				type: "state_changed",
				source: "journal",
				action: "created",
				key: topic,
				summary: content.slice(0, 100),
				timestamp: now,
			});
		}

		return id;
	}

	/** Get recent journal entries */
	getRecentJournal(limit: number = 20): JournalRow[] {
		return this.ctx.storage.sql
			.exec<JournalRow>("SELECT * FROM journal ORDER BY timestamp DESC LIMIT ?", limit)
			.toArray();
	}

	/** Get journal entries by topic */
	getJournalByTopic(topic: string, limit: number = 50): JournalRow[] {
		return this.ctx.storage.sql
			.exec<JournalRow>(
				"SELECT * FROM journal WHERE topic = ? ORDER BY timestamp DESC LIMIT ?",
				topic,
				limit,
			)
			.toArray();
	}

	// ==========================================
	// Query Methods
	// ==========================================

	/** Query memory with filters - uses SQLite for filtered queries, Vectorize for semantic */
	async queryMemory(params: {
		query?: string;
		type?: string;
		knowledgeType?: string;
		topic?: string;
		since?: string;
		until?: string;
		limit?: number;
		offset?: number;
	}): Promise<{ results: QueryResult[]; total: number }> {
		const limit = params.limit ?? 10;
		const offset = params.offset ?? 0;

		// If we have a semantic query, use Vectorize
		if (params.query) {
			return this.semanticQuery(params);
		}

		// Otherwise, use SQLite for filtered queries
		const results: QueryResult[] = [];
		let total = 0;

		const typeFilter = params.type ?? "all";

		// Query journal
		if (typeFilter === "all" || typeFilter === "journal") {
			const journalResults = this.queryJournalSql(params, limit, offset);
			results.push(...journalResults.results);
			total += journalResults.total;
		}

		// Query knowledge
		if (typeFilter === "all" || typeFilter === "knowledge") {
			const knowledgeResults = this.queryKnowledgeSql(params, limit - results.length, offset);
			results.push(...knowledgeResults.results);
			total += knowledgeResults.total;
		}

		// Query core context
		if (typeFilter === "all" || typeFilter === "core") {
			const coreResults = this.queryCoreContextSql();
			results.push(...coreResults);
			total += coreResults.length;
		}

		return { results: results.slice(0, limit), total };
	}

	/** Semantic query using Vectorize */
	private async semanticQuery(params: {
		query?: string;
		type?: string;
		knowledgeType?: string;
		topic?: string;
		since?: string;
		until?: string;
		limit?: number;
	}): Promise<{ results: QueryResult[]; total: number }> {
		if (!params.query) {
			return { results: [], total: 0 };
		}

		const embedding = await this.getEmbedding(params.query);
		const limit = params.limit ?? 10;

		// Build Vectorize filter
		const filter: VectorizeVectorMetadataFilter = {};

		if (params.type && params.type !== "all") {
			filter.type = { $eq: params.type };
		}

		if (params.knowledgeType) {
			filter.subtype = { $eq: params.knowledgeType };
		}

		if (params.topic) {
			filter.topic = { $eq: params.topic };
		}

		// Time-based filtering via metadata timestamp
		if (params.since && params.until) {
			const sinceTs = new Date(params.since).getTime();
			const untilTs = new Date(params.until).getTime();
			filter.timestamp = { $gte: sinceTs, $lte: untilTs };
		} else if (params.since) {
			const sinceTs = new Date(params.since).getTime();
			filter.timestamp = { $gte: sinceTs };
		} else if (params.until) {
			const untilTs = new Date(params.until).getTime();
			filter.timestamp = { $lte: untilTs };
		}

		const hasFilter = Object.keys(filter).length > 0;

		const vectorResults = await this.env.VECTORIZE.query(embedding, {
			topK: limit,
			returnMetadata: "all",
			filter: hasFilter ? filter : undefined,
		});

		const results: QueryResult[] = vectorResults.matches.map((m) => {
			const meta = m.metadata as Record<string, unknown>;
			return {
				id: m.id,
				type: String(meta.type ?? "unknown"),
				subtype: meta.subtype ? String(meta.subtype) : undefined,
				topic: meta.topic ? String(meta.topic) : undefined,
				name: meta.name ? String(meta.name) : undefined,
				content: String(meta.content ?? ""),
				score: m.score,
				timestamp: new Date(Number(meta.timestamp ?? 0)).toISOString(),
			};
		});

		return { results, total: results.length };
	}

	/** Query journal via SQLite */
	private queryJournalSql(
		params: { topic?: string; since?: string; until?: string },
		limit: number,
		offset: number,
	): { results: QueryResult[]; total: number } {
		const conditions: string[] = [];
		const countParams: (string | number)[] = [];
		const queryParams: (string | number)[] = [];

		if (params.topic) {
			conditions.push("topic = ?");
			countParams.push(params.topic);
			queryParams.push(params.topic);
		}
		if (params.since) {
			conditions.push("timestamp >= ?");
			countParams.push(params.since);
			queryParams.push(params.since);
		}
		if (params.until) {
			conditions.push("timestamp <= ?");
			countParams.push(params.until);
			queryParams.push(params.until);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		const countResult = this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) as count FROM journal ${where}`, ...countParams)
			.toArray();
		const total = countResult[0]?.count ?? 0;

		queryParams.push(limit, offset);
		const rows = this.ctx.storage.sql
			.exec<JournalRow>(
				`SELECT * FROM journal ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
				...queryParams,
			)
			.toArray();

		return {
			results: rows.map((r) => ({
				id: r.id,
				type: "journal",
				topic: r.topic,
				content: r.content,
				timestamp: r.timestamp,
			})),
			total,
		};
	}

	/** Query knowledge via SQLite */
	private queryKnowledgeSql(
		params: { knowledgeType?: string; since?: string; until?: string },
		limit: number,
		offset: number,
	): { results: QueryResult[]; total: number } {
		const conditions: string[] = [];
		const countParams: (string | number)[] = [];
		const queryParams: (string | number)[] = [];

		if (params.knowledgeType) {
			conditions.push("type = ?");
			countParams.push(params.knowledgeType);
			queryParams.push(params.knowledgeType);
		}
		if (params.since) {
			conditions.push("updated_at >= ?");
			countParams.push(params.since);
			queryParams.push(params.since);
		}
		if (params.until) {
			conditions.push("updated_at <= ?");
			countParams.push(params.until);
			queryParams.push(params.until);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

		const countResult = this.ctx.storage.sql
			.exec<{ count: number }>(`SELECT COUNT(*) as count FROM knowledge ${where}`, ...countParams)
			.toArray();
		const total = countResult[0]?.count ?? 0;

		queryParams.push(limit, offset);
		const rows = this.ctx.storage.sql
			.exec<KnowledgeRow>(
				`SELECT * FROM knowledge ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
				...queryParams,
			)
			.toArray();

		return {
			results: rows.map((r) => ({
				id: r.id,
				type: "knowledge",
				subtype: r.type,
				name: r.name,
				content: r.content,
				timestamp: r.updated_at,
			})),
			total,
		};
	}

	/** Query core context via SQLite */
	private queryCoreContextSql(): QueryResult[] {
		const rows = this.ctx.storage.sql.exec<CoreContextRow>("SELECT * FROM core_context").toArray();
		return rows.map((r) => ({
			id: `core-${r.which}`,
			type: "core",
			name: r.which,
			content: r.content,
			timestamp: r.updated_at,
		}));
	}

	/** Get memory statistics */
	getMemoryStats(): MemoryStats {
		// Journal stats
		const journalCount = this.ctx.storage.sql
			.exec<{ count: number }>("SELECT COUNT(*) as count FROM journal")
			.toArray()[0]?.count ?? 0;
		const journalOldest = this.ctx.storage.sql
			.exec<{ timestamp: string }>("SELECT timestamp FROM journal ORDER BY timestamp ASC LIMIT 1")
			.toArray()[0]?.timestamp ?? null;
		const journalNewest = this.ctx.storage.sql
			.exec<{ timestamp: string }>("SELECT timestamp FROM journal ORDER BY timestamp DESC LIMIT 1")
			.toArray()[0]?.timestamp ?? null;

		// Knowledge stats
		const knowledgeTotal = this.ctx.storage.sql
			.exec<{ count: number }>("SELECT COUNT(*) as count FROM knowledge")
			.toArray()[0]?.count ?? 0;
		const knowledgeByType = this.ctx.storage.sql
			.exec<{ type: string; count: number }>("SELECT type, COUNT(*) as count FROM knowledge GROUP BY type")
			.toArray();
		const byType: Record<string, number> = {};
		for (const row of knowledgeByType) {
			byType[row.type] = row.count;
		}

		// Core context stats
		const identity = this.getCoreContext("identity") !== null;
		const today = this.getCoreContext("today") !== null;
		const human = this.getCoreContext("human") !== null;

		return {
			journal: { count: journalCount, oldest: journalOldest, newest: journalNewest },
			knowledge: { total: knowledgeTotal, byType },
			summaries: { count: 0 }, // Summaries are in Vectorize only
			core: { identity, today, human },
		};
	}

	/** Export all memory as JSON */
	exportMemory(types?: string[]): {
		core: Record<string, string>;
		knowledge: Array<{ type: string; name: string; content: string; tags: string[] }>;
		journal: Array<{ topic: string; content: string; intent?: string; timestamp: string }>;
	} {
		const includeAll = !types || types.length === 0;

		// Core context
		const core: Record<string, string> = {};
		if (includeAll || types?.includes("core")) {
			const coreRows = this.ctx.storage.sql.exec<CoreContextRow>("SELECT * FROM core_context").toArray();
			for (const row of coreRows) {
				core[row.which] = row.content;
			}
		}

		// Knowledge
		let knowledge: Array<{ type: string; name: string; content: string; tags: string[] }> = [];
		if (includeAll || types?.includes("knowledge")) {
			const knowledgeRows = this.getAllKnowledge();
			knowledge = knowledgeRows.map((r) => ({
				type: r.type,
				name: r.name,
				content: r.content,
				tags: r.tags ? JSON.parse(r.tags) : [],
			}));
		}

		// Journal
		let journal: Array<{ topic: string; content: string; intent?: string; timestamp: string }> = [];
		if (includeAll || types?.includes("journal")) {
			const journalRows = this.ctx.storage.sql
				.exec<JournalRow>("SELECT * FROM journal ORDER BY timestamp DESC")
				.toArray();
			journal = journalRows.map((r) => ({
				topic: r.topic,
				content: r.content,
				intent: r.intent ?? undefined,
				timestamp: r.timestamp,
			}));
		}

		return { core, knowledge, journal };
	}

	// ==========================================
	// Agent Context & Tools
	// ==========================================

	/** Build the full context string (used by get_context tool and daemon endpoint) */
	buildContextString(identityName?: string): string {
		// If identityName provided, fetch from knowledge; otherwise use core context
		let identityContent: string | null = null;
		if (identityName) {
			const knowledgeIdentity = this.getKnowledge("identity", identityName);
			identityContent = knowledgeIdentity?.content ?? null;
		}
		if (!identityContent) {
			const coreIdentity = this.getCoreContext("identity");
			identityContent = coreIdentity?.content ?? null;
		}

		const human = this.getCoreContext("human");
		const today = this.getCoreContext("today");
		const recentJournal = this.getRecentJournal(5);
		const schedules = this.getSchedules();

		const recent = recentJournal.map((j) => `- [${j.topic}] ${j.content}`).join("\n");

		const scheduleSummary =
			schedules.length > 0
				? schedules
						.map((s) => {
							const payload = s.payload as { description?: string };
							return `- ${payload?.description ?? s.id}`;
						})
						.join("\n")
				: "No schedules configured.";

		return `## Identity
${identityContent ?? "No identity set."}

## Human
${human?.content ?? "No human profile yet."}

## Today
${today?.content ?? "No focus set for today."}

## Recent Activity
${recent || "No recent entries."}

## Active Schedules
${scheduleSummary}`;
	}

	/** Get context for sub-agents (shorter version) */
	private getAgentContext(): string {
		const identity = this.getCoreContext("identity");
		const human = this.getCoreContext("human");
		const today = this.getCoreContext("today");

		const parts: string[] = [];
		if (identity) parts.push(`## Identity\n${identity.content}`);
		if (human) parts.push(`## Human\n${human.content}`);
		if (today) parts.push(`## Today\n${today.content}`);

		return parts.join("\n\n");
	}

	/** Create tools for sub-agent use with AI SDK */
	private createAgentTools() {
		const self = this;
		return {
			write_core: tool({
				description: "Update core context (identity, today, or human profile)",
				inputSchema: z.object({
					which: z.enum(["identity", "today", "human"]),
					content: z.string().describe("Content to write"),
				}),
				execute: async ({ which, content }) => {
					await self.saveCoreContext(which, content);
					return `Updated ${which}`;
				},
			}),
			save_knowledge: tool({
				description: "Save or update a knowledge entry",
				inputSchema: z.object({
					type: z.string().describe("Knowledge type (e.g., topic, project, person, goal)"),
					name: z.string().describe("Entry name"),
					content: z.string().describe("Content to save"),
					tags: z.array(z.string()).optional().describe("Optional tags"),
				}),
				execute: async ({ type, name, content, tags }) => {
					await self.saveKnowledge(type, name, content, tags);
					return `Saved ${type}/${name}`;
				},
			}),
			read_knowledge: tool({
				description: "Read a knowledge entry",
				inputSchema: z.object({
					type: z.string().describe("Knowledge type"),
					name: z.string().describe("Entry name"),
				}),
				execute: async ({ type, name }) => {
					const row = self.getKnowledge(type, name);
					return row ? row.content : `Not found: ${type}/${name}`;
				},
			}),
			observe: tool({
				description: "Record an observation, decision, or thing to remember",
				inputSchema: z.object({
					topic: z.string().describe("Short topic/category"),
					content: z.string().describe("The journal entry content"),
					intent: z.string().optional().describe("Why you're logging this"),
				}),
				execute: async ({ topic, content, intent }) => {
					await self.saveJournal(topic, content, intent);
					return `Observation recorded: ${topic}`;
				},
			}),
			query_memory: tool({
				description: "Search memory using semantic search or filters",
				inputSchema: z.object({
					query: z.string().optional().describe("Semantic search query"),
					type: z.string().optional().describe("Filter by type: journal, knowledge, core, all"),
					knowledgeType: z.string().optional().describe("Filter knowledge by type"),
					limit: z.number().optional().default(10),
				}),
				execute: async ({ query, type, knowledgeType, limit }) => {
					const { results } = await self.queryMemory({ query, type, knowledgeType, limit });
					if (results.length === 0) return "No relevant memories found.";
					return results
						.map((r) => `[${r.type}${r.subtype ? `:${r.subtype}` : ""}] ${r.topic ?? r.name ?? ""}: ${r.content}`)
						.join("\n\n");
				},
			}),
			list_knowledge: tool({
				description: "List all knowledge entries, optionally filtered by type",
				inputSchema: z.object({
					type: z.string().optional().describe("Filter by knowledge type"),
				}),
				execute: async ({ type }) => {
					const rows = type ? self.getKnowledgeByType(type) : self.getAllKnowledge();
					if (rows.length === 0) return type ? `No ${type} entries yet.` : "No knowledge yet.";
					return rows.map((r) => `- ${r.type}/${r.name}`).join("\n");
				},
			}),
			query_web: tool({
				description: "Search the web for information",
				inputSchema: z.object({
					query: z.string().describe("Search query"),
					type: z.enum(["general", "news"]).optional().default("general"),
					count: z.number().optional().default(5),
				}),
				execute: async ({ query, type, count }) => {
					const apiKey = self.env.BRAVE_SEARCH_API_KEY;
					if (!apiKey) return "Error: BRAVE_SEARCH_API_KEY not configured";
					try {
						const results =
							type === "news"
								? await searchNews(query, apiKey, { count: Math.min(count ?? 5, 10) })
								: await searchWeb(query, apiKey, { count: Math.min(count ?? 5, 10) });
						if (results.length === 0) return `No results found for "${query}"`;
						return results.map((r) => `**${r.title}**\n${r.url}\n${r.description}`).join("\n\n");
					} catch (error) {
						return `Search error: ${error instanceof Error ? error.message : String(error)}`;
					}
				},
			}),
			list_external_mcps: tool({
				description: "List all connected external MCP servers",
				inputSchema: z.object({}),
				execute: async () => {
					const mcps = await self.getConnectedMcps();
					if (mcps.length === 0) return "No external MCPs connected.";
					return mcps.map((m) => `- ${m.name}: ${m.endpoint}`).join("\n");
				},
			}),
			list_external_tools: tool({
				description: "List available tools from an external MCP server",
				inputSchema: z.object({
					mcpName: z.string().describe("Name of the connected MCP"),
				}),
				execute: async ({ mcpName }) => {
					const mcps = await self.getConnectedMcps();
					const mcp = mcps.find((m) => m.name === mcpName);
					if (!mcp) return `MCP "${mcpName}" not found.`;
					try {
						const tools = await self.fetchMcpTools(mcp);
						if (tools.length === 0) return `No tools available from ${mcpName}.`;
						return tools.map((t) => `- ${t.name}: ${t.description || "(no description)"}`).join("\n");
					} catch (error) {
						return `Error: ${error instanceof Error ? error.message : String(error)}`;
					}
				},
			}),
			call_external_tool: tool({
				description: "Call a tool on an external MCP server",
				inputSchema: z.object({
					mcpName: z.string().describe("Name of the connected MCP"),
					toolName: z.string().describe("Name of the tool to call"),
					args: z.record(z.string(), z.unknown()).optional().describe("Arguments to pass to the tool"),
				}),
				execute: async ({ mcpName, toolName, args }) => {
					const mcps = await self.getConnectedMcps();
					const mcp = mcps.find((m) => m.name === mcpName);
					if (!mcp) return `MCP "${mcpName}" not found.`;
					try {
						return await self.callMcpTool(mcp, toolName, args ?? {});
					} catch (error) {
						return `Error: ${error instanceof Error ? error.message : String(error)}`;
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

	async onStart() {
		this.initSchema();
	}


	// ==========================================
	// MCP Tool Registration
	// ==========================================

	private registerTools(server: McpServer) {
		// ==========================================
		// Context Tools (2)
		// ==========================================

		server.tool(
			"get_context",
			"IMPORTANT: Call this at the start of EVERY session to load your identity, human profile, today's focus, recent activity, and schedules.",
			{},
			async () => {
				const identity = this.getCoreContext("identity");

				// Detect first run
				if (!identity) {
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
write_core(
  which: "identity",
  content: "# [Name]\\n\\nI am a stateful agent for [user]. I help with [focus areas].\\n\\n## Communication Style\\n[based on preferences]\\n\\n## Operating Principles\\n- Write state immediately when something happens\\n- Search memory before claiming ignorance\\n- Capture learnings in the moment"
)
\`\`\`

### 2. Create human profile
\`\`\`
write_core(
  which: "human",
  content: "# [Name]\\n\\n[Bio from their links]\\n\\n## Role\\n[what they do]\\n\\n## Timezone\\n[e.g., Europe/London]\\n\\n## Work Schedule\\n[e.g., 9am-6pm]"
)
\`\`\`

### 3. Set up end-of-day review
\`\`\`
schedule_task(
  id: "end-of-day",
  cron: "0 18 * * 1-5",  // 6pm weekdays - adjust to their schedule
  description: "End of day review",
  task: "reflect",
  payload: "Review today's conversations and activity. Identify key learnings, decisions made, and open threads. Update relevant knowledge. Note anything to follow up on tomorrow.",
  model: "thinking"
)
\`\`\`

### 4. Set up weekly memory maintenance
\`\`\`
schedule_task(
  id: "memory-maintenance",
  cron: "0 3 * * 0",  // Sunday 3am
  description: "Weekly memory maintenance",
  task: "cleanup",
  payload: "Review all knowledge and journal entries from the past week. Consolidate related learnings. Prune outdated information. Identify patterns worth preserving.",
  model: "thinking"
)
\`\`\`

Then you're ready to help.`,
							},
						],
					};
				}

				// Normal context response
				return {
					content: [
						{
							type: "text",
							text: this.buildContextString(),
						},
					],
				};
			},
		);

		server.tool(
			"write_core",
			"Update one of the three core context files: identity (who you are), today (current focus), or human (user profile).",
			{
				which: z.enum(["identity", "today", "human"]).describe("Which core context to update"),
				content: z.string().describe("The content to write"),
			},
			async ({ which, content }) => {
				await this.saveCoreContext(which, content);
				return {
					content: [{ type: "text", text: `Updated ${which}` }],
				};
			},
		);

		// ==========================================
		// Knowledge Tools (5)
		// ==========================================

		server.tool(
			"save_knowledge",
			"Save or update a knowledge entry. Knowledge types are flexible - use whatever makes sense (topic, project, person, goal, pattern, etc.).",
			{
				type: z.string().describe("Knowledge type (e.g., topic, project, person, goal)"),
				name: z.string().describe("Entry name (unique within type)"),
				content: z.string().describe("The content to save"),
				tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
			},
			async ({ type, name, content, tags }) => {
				await this.saveKnowledge(type, name, content, tags);
				return {
					content: [{ type: "text", text: `Saved ${type}/${name}` }],
				};
			},
		);

		server.tool(
			"read_knowledge",
			"Read a single knowledge entry by type and name.",
			{
				type: z.string().describe("Knowledge type"),
				name: z.string().describe("Entry name"),
			},
			async ({ type, name }) => {
				const row = this.getKnowledge(type, name);
				if (!row) {
					return {
						content: [{ type: "text", text: `Not found: ${type}/${name}` }],
					};
				}
				return {
					content: [{ type: "text", text: row.content }],
				};
			},
		);

		server.tool(
			"batch_read_knowledge",
			"Read multiple knowledge entries at once.",
			{
				entries: z
					.array(
						z.object({
							type: z.string(),
							name: z.string(),
						}),
					)
					.describe("List of entries to read"),
			},
			async ({ entries }) => {
				const results: Record<string, string | null> = {};
				for (const entry of entries) {
					const key = `${entry.type}/${entry.name}`;
					const row = this.getKnowledge(entry.type, entry.name);
					results[key] = row?.content ?? null;
				}
				return {
					content: [{ type: "text", text: JSON.stringify({ entries: results }, null, 2) }],
				};
			},
		);

		server.tool(
			"list_knowledge",
			"List all stored knowledge, optionally filtered by type.",
			{
				type: z.string().optional().describe("Filter by knowledge type"),
			},
			async ({ type }) => {
				const rows = type ? this.getKnowledgeByType(type) : this.getAllKnowledge();

				if (rows.length === 0) {
					return {
						content: [{ type: "text", text: type ? `No ${type} entries yet.` : "No knowledge yet." }],
					};
				}

				// Group by type
				const byType: Record<string, Array<{ name: string; updatedAt: string }>> = {};
				for (const row of rows) {
					if (!byType[row.type]) byType[row.type] = [];
					byType[row.type].push({ name: row.name, updatedAt: row.updated_at });
				}

				return {
					content: [{ type: "text", text: JSON.stringify({ types: byType }, null, 2) }],
				};
			},
		);

		server.tool(
			"delete_knowledge",
			"Delete a knowledge entry.",
			{
				type: z.string().describe("Knowledge type"),
				name: z.string().describe("Entry name"),
			},
			async ({ type, name }) => {
				const deleted = await this.deleteKnowledge(type, name);
				return {
					content: [
						{
							type: "text",
							text: deleted ? `Deleted ${type}/${name}` : `Not found: ${type}/${name}`,
						},
					],
				};
			},
		);

		// ==========================================
		// Journal Tools (2)
		// ==========================================

		server.tool(
			"observe",
			"Record an observation, decision, or thing to remember. Entries are searchable via semantic search.",
			{
				topic: z.string().describe("Short topic/category for the entry"),
				content: z.string().describe("The observation content"),
				intent: z.string().optional().describe("Why you're recording this"),
			},
			async ({ topic, content, intent }) => {
				console.log(`[OBSERVE] ${topic}: ${content.slice(0, 50)}...`);
				const id = await this.saveJournal(topic, content, intent);
				console.log(`[OBSERVE] Entry saved with ID: ${id}`);
				return {
					content: [{ type: "text", text: `Observation recorded: ${topic}` }],
				};
			},
		);

		server.tool(
			"save_summary",
			"Save a summary of the current conversation for context recovery in future sessions.",
			{
				summary: z.string().describe("Brief summary of what was discussed/accomplished"),
				keyDecisions: z.array(z.string()).optional().describe("Important decisions made"),
				openThreads: z.array(z.string()).optional().describe("Topics to follow up on"),
				learnedPatterns: z.array(z.string()).optional().describe("New patterns learned about the user"),
			},
			async ({ summary, keyDecisions, openThreads, learnedPatterns }) => {
				const id = `summary-${new Date().toISOString().slice(0, 10)}-${Date.now()}`;
				const content = [
					summary,
					keyDecisions?.length ? `\nDecisions: ${keyDecisions.join(", ")}` : "",
					openThreads?.length ? `\nOpen threads: ${openThreads.join(", ")}` : "",
					learnedPatterns?.length ? `\nLearned: ${learnedPatterns.join(", ")}` : "",
				].join("");

				const embedding = await this.getEmbedding(content);

				await this.env.VECTORIZE.upsert([
					{
						id,
						values: embedding,
						metadata: { type: "summary", timestamp: Date.now(), content },
					},
				]);

				return {
					content: [{ type: "text", text: "Conversation summary saved." }],
				};
			},
		);

		// ==========================================
		// Query Tools (3)
		// ==========================================

		server.tool(
			"query_memory",
			"Search your memory using semantic search and/or filters. Returns the most relevant items.",
			{
				query: z.string().optional().describe("Semantic search query"),
				type: z
					.enum(["all", "journal", "knowledge", "summary", "core"])
					.optional()
					.default("all")
					.describe("Filter by content type"),
				knowledgeType: z.string().optional().describe("Filter knowledge by type (e.g., topic, project)"),
				topic: z.string().optional().describe("Filter journal by topic"),
				since: z.string().optional().describe("Filter by date (ISO format, e.g., 2024-01-01)"),
				until: z.string().optional().describe("Filter by date (ISO format)"),
				limit: z.number().optional().default(10).describe("Maximum results"),
				offset: z.number().optional().default(0).describe("Offset for pagination"),
			},
			async ({ query, type, knowledgeType, topic, since, until, limit, offset }) => {
				const { results, total } = await this.queryMemory({
					query,
					type,
					knowledgeType,
					topic,
					since,
					until,
					limit,
					offset,
				});

				if (results.length === 0) {
					return {
						content: [{ type: "text", text: "No relevant memories found." }],
					};
				}

				return {
					content: [{ type: "text", text: JSON.stringify({ results, total }, null, 2) }],
				};
			},
		);

		server.tool("memory_stats", "Get statistics about your memory storage.", {}, async () => {
			const stats = this.getMemoryStats();
			return {
				content: [{ type: "text", text: JSON.stringify(stats, null, 2) }],
			};
		});

		server.tool(
			"export_memory",
			"Export all memory as JSON. Useful for backup or inspection.",
			{
				types: z
					.array(z.enum(["core", "knowledge", "journal"]))
					.optional()
					.describe("Which types to export (default: all)"),
			},
			async ({ types }) => {
				const exported = this.exportMemory(types);
				return {
					content: [{ type: "text", text: JSON.stringify(exported, null, 2) }],
				};
			},
		);

		// ==========================================
		// Web Tools (2)
		// ==========================================

		server.tool(
			"query_web",
			"Search the web for current information. Use 'news' type for recent news articles.",
			{
				query: z.string().describe("Search query"),
				type: z.enum(["general", "news"]).optional().default("general").describe("Search type"),
				count: z.number().optional().default(5).describe("Number of results (max 10)"),
			},
			async ({ query, type, count }) => {
				const apiKey = this.env.BRAVE_SEARCH_API_KEY;
				if (!apiKey) {
					return {
						content: [{ type: "text", text: "Error: BRAVE_SEARCH_API_KEY not configured" }],
					};
				}

				try {
					const results =
						type === "news"
							? await searchNews(query, apiKey, { count: Math.min(count, 10) })
							: await searchWeb(query, apiKey, { count: Math.min(count, 10) });

					if (results.length === 0) {
						return {
							content: [{ type: "text", text: `No results found for "${query}"` }],
						};
					}

					const formatted = results
						.map((r) => `**${r.title}**\n${r.url}\n${r.description}${r.age ? ` (${r.age})` : ""}`)
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

		server.tool(
			"fetch_page",
			"Fetch a webpage and convert to markdown. Any URL is allowed, but URLs not from search results will be logged for audit.",
			{
				url: z.string().url().describe("URL to fetch"),
				waitForJs: z.boolean().optional().default(false).describe("Wait for JavaScript to execute"),
			},
			async ({ url, waitForJs }) => {
				const apiToken = this.env.CF_API_TOKEN;
				const accountId = this.env.CF_ACCOUNT_ID;
				if (!apiToken || !accountId) {
					return {
						content: [{ type: "text", text: "Error: CF_API_TOKEN or CF_ACCOUNT_ID not configured" }],
					};
				}

				// Log the fetch for audit
				await this.saveJournal("web:fetch", `Fetched URL: ${url}`, "audit");

				try {
					const markdown = await fetchPageAsMarkdown(url, accountId, apiToken, {
						waitUntil: waitForJs ? "networkidle0" : undefined,
					});

					const maxLength = 50000;
					let result = markdown;
					if (markdown.length > maxLength) {
						result = markdown.slice(0, maxLength) + "\n\n[Content truncated...]";
					}

					return { content: [{ type: "text", text: result }] };
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
		// Scheduling Tools (3)
		// ==========================================

		const modelOptions = formatModelOptions();

		server.tool(
			"schedule_task",
			`Schedule a task to run at a specific time or on a recurring schedule. Use 'cron' for recurring (e.g., "0 9 * * 1-5" for 9am weekdays) or 'at' for one-time (ISO datetime).\n\n${modelOptions}`,
			{
				id: z.string().describe("Unique identifier for this schedule"),
				description: z.string().describe("What this schedule does"),
				task: z
					.enum(["consolidate", "reflect", "cleanup", "briefing", "custom"])
					.describe("Type of task to run"),
				payload: z.string().optional().describe("Custom instructions for the task"),
				model: z
					.enum(["fast", "thinking", "local"])
					.optional()
					.describe("Model tier: 'fast' (quick), 'thinking' (deep reasoning), 'local' (free)"),
				cron: z.string().optional().describe("Cron expression for recurring tasks"),
				at: z.string().optional().describe("ISO datetime for one-time tasks"),
			},
			async ({ id, description, task, payload, model, cron, at }) => {
				if (!cron && !at) {
					return {
						content: [{ type: "text", text: "Error: Must specify either 'cron' or 'at'" }],
					};
				}

				const scheduleData = {
					id,
					task,
					description,
					payload: payload ?? description,
					model,
				};

				if (cron) {
					await this.schedule(cron, "runScheduledTask", scheduleData);
					return {
						content: [
							{
								type: "text",
								text: `Scheduled recurring task "${description}" with cron: ${cron}`,
							},
						],
					};
				} else if (at) {
					const date = new Date(at);
					await this.schedule(date, "runScheduledTask", scheduleData);
					return {
						content: [
							{
								type: "text",
								text: `Scheduled one-time task "${description}" for ${date.toISOString()}`,
							},
						],
					};
				}

				return { content: [{ type: "text", text: "Error: Invalid schedule configuration" }] };
			},
		);

		server.tool("list_schedules", "List all scheduled tasks.", {}, async () => {
			const schedules = this.getSchedules();

			if (schedules.length === 0) {
				return {
					content: [{ type: "text", text: JSON.stringify({ schedules: [] }, null, 2) }],
				};
			}

			const formatted = schedules.map((s) => {
				const payload = s.payload as { id?: string; description?: string; task?: string; cron?: string };
				const timeMs = s.time ? s.time * 1000 : 0;
				return {
					id: payload?.id ?? s.id,
					description: payload?.description ?? payload?.task ?? "Unknown",
					task: payload?.task,
					cron: s.type === "cron" ? s.cron : undefined,
					at: s.type !== "cron" ? new Date(timeMs).toISOString() : undefined,
					nextRun: timeMs ? new Date(timeMs).toISOString() : null,
				};
			});

			return {
				content: [{ type: "text", text: JSON.stringify({ schedules: formatted }, null, 2) }],
			};
		});

		server.tool(
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
		// Refine Tool
		// ==========================================

		server.tool(
			"refine",
			"Ask the cloud agent to do deep processing on your memory - consolidation, pattern recognition, cleanup. The agent has tool access and can make changes. Returns immediately; check journal for results.",
			{
				task: z
					.enum(["consolidate", "reflect", "cleanup", "research"])
					.describe("What kind of refinement to do"),
				focus: z.string().optional().describe("Specific area to focus on"),
			},
			async ({ task, focus }) => {
				const taskDescriptions: Record<string, string> = {
					consolidate:
						"Review recent journal entries and consolidate them into updated knowledge. Look for patterns, recurring themes, and knowledge worth preserving. Create or update knowledge entries as needed.",
					reflect:
						"Reflect on recent activity and identify insights, patterns, or things worth remembering. Log important observations and update relevant knowledge.",
					cleanup:
						"Review memory for stale, outdated, or redundant entries. Update or remove outdated information from knowledge. Keep things current.",
					research:
						"Research and gather information using web search. Save findings to relevant knowledge or journal.",
				};

				const prompt = focus
					? `${taskDescriptions[task]}\n\nFocus area: ${focus}`
					: taskDescriptions[task];

				const taskId = `refine-${task}-${Date.now()}`;
				console.log(`[REFINE] Starting background task: ${taskId}`);

				this.runAgentTask({
					task: `refine:${task}`,
					prompt,
					model: "thinking",
				})
					.then(async (result) => {
						console.log(`[REFINE] Task ${taskId} completed`);
						await this.saveJournal(
							`refine:${task}`,
							`Completed refinement task.\n\n${result.slice(0, 2000)}`,
						);
					})
					.catch(async (error) => {
						console.error(`[REFINE] Task ${taskId} failed:`, error);
						await this.saveJournal(
							`refine:${task}:error`,
							`Refinement failed: ${error instanceof Error ? error.message : String(error)}`,
						);
					});

				return {
					content: [
						{
							type: "text",
							text: `Started background refinement: ${task}${focus ? ` (focus: ${focus})` : ""}. Results will be logged to journal.`,
						},
					],
				};
			},
		);

		// ==========================================
		// External MCP Tools (3)
		// ==========================================

		server.tool("list_external_mcps", "List all connected external MCP servers.", {}, async () => {
			const mcps = await this.getConnectedMcps();

			const formatted = mcps.map((m) => ({
				name: m.name,
				endpoint: m.endpoint,
				connectedAt: m.connectedAt,
			}));

			return {
				content: [{ type: "text", text: JSON.stringify({ mcps: formatted }, null, 2) }],
			};
		});

		server.tool(
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
						content: [{ type: "text", text: `MCP "${mcpName}" not found.` }],
					};
				}

				try {
					const tools = await this.fetchMcpTools(mcp);

					const formatted = tools.map((t) => ({
						name: t.name,
						description: t.description || undefined,
						inputSchema: t.inputSchema,
					}));

					return {
						content: [{ type: "text", text: JSON.stringify({ tools: formatted }, null, 2) }],
					};
				} catch (error) {
					return {
						content: [
							{
								type: "text",
								text: `Error: ${error instanceof Error ? error.message : String(error)}`,
							},
						],
					};
				}
			},
		);

		server.tool(
			"call_external_tool",
			"Call a tool on an external MCP server.",
			{
				mcpName: z.string().describe("Name of the connected MCP"),
				toolName: z.string().describe("Name of the tool to call"),
				args: z.record(z.string(), z.unknown()).optional().describe("Arguments to pass to the tool"),
			},
			async ({ mcpName, toolName, args }) => {
				const mcps = await this.getConnectedMcps();
				const mcp = mcps.find((m) => m.name === mcpName);

				if (!mcp) {
					return {
						content: [{ type: "text", text: `MCP "${mcpName}" not found.` }],
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
								text: `Error: ${error instanceof Error ? error.message : String(error)}`,
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

		const taskPrompts: Record<string, string> = {
			consolidate:
				"Review recent journal entries and consolidate learnings into updated knowledge. Use query_memory to find relevant entries, then use save_knowledge to update or create entries. Identify patterns and knowledge worth preserving.",
			reflect:
				"Reflect on recent activity and identify insights, patterns, or things worth remembering. Search memory for recent entries, log important observations, and update relevant knowledge.",
			cleanup:
				"Review memory for stale, outdated, or redundant entries. Search for old knowledge, check if it's still accurate, and update or consolidate as needed. Keep the knowledge base current.",
			briefing:
				"Prepare a briefing of what's important and what needs attention. Search memory for recent activity, priorities, and open threads. Summarize key points.",
			custom: data.payload ?? "Execute the scheduled task using available tools.",
		};

		const basePrompt = taskPrompts[data.task] ?? taskPrompts.custom;
		const prompt =
			data.payload && data.task !== "custom"
				? `${basePrompt}\n\nAdditional instructions: ${data.payload}`
				: basePrompt;

		const needsThinking = ["reflect", "cleanup", "consolidate"].includes(data.task);
		const modelTier = data.model ?? (needsThinking ? "thinking" : "fast");

		try {
			const result = await this.runAgentTask({
				task: `scheduled:${data.task}`,
				prompt,
				model: modelTier,
			});

			await this.saveJournal(
				`scheduled-${data.task}`,
				`Completed scheduled task: ${data.description ?? data.task}\n\nOutput:\n${result.slice(0, 500)}`,
			);

			console.log(`[SCHEDULED] Task complete: ${data.description ?? data.task}`);
		} catch (error) {
			console.error(`[SCHEDULED] Task failed: ${error}`);
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

	private getUserId(): string {
		return this.ctx.id.toString();
	}

	async getConnectedMcps(): Promise<ConnectedMcp[]> {
		const userId = this.getUserId();
		const mcpsJson = await this.env.OAUTH_KV?.get(`user:${userId}:mcps`);
		return mcpsJson ? JSON.parse(mcpsJson) : [];
	}

	async fetchMcpTools(mcp: ConnectedMcp): Promise<McpTool[]> {
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
			result?: { tools: McpTool[] };
			error?: { message: string };
		};

		if (result.error) {
			throw new Error(result.error.message);
		}

		return result.result?.tools ?? [];
	}

	async callMcpTool(mcp: ConnectedMcp, toolName: string, args: Record<string, unknown>): Promise<string> {
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

		const textContent = result.result?.content
			?.filter((c) => c.type === "text" && c.text)
			.map((c) => c.text)
			.join("\n");

		return textContent || "Tool returned no text content.";
	}
}
