/**
 * Context formatting for OpenCode plugin
 *
 * Reads state files and formats them for injection into conversations
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync } from "fs";

import { join } from "path";
import type { TextPart } from "@opencode-ai/sdk";
import { getStateRoot, getJournalDir, getRemindersDir } from "../src/config.js";
import { detectUser } from "../src/detect-user.js";

/**
 * Read and clear pending context from daemon
 */
export function consumePendingContext(): string | null {
  const pendingPath = join(getStateRoot(), ".pending-context");
  if (!existsSync(pendingPath)) return null;

  try {
    const content = readFileSync(pendingPath, "utf-8").trim();
    unlinkSync(pendingPath);
    return content || null;
  } catch {
    return null;
  }
}

// Re-export for compatibility
export { getStateRoot } from "../src/config.js";

/**
 * Initialize state directory structure (directories only, no default files)
 * Files are created during onboarding.
 */
export function initializeStateRoot(): void {
  const stateRoot = getStateRoot();
  
  // Create directories only - files created during onboarding
  const dirs = [
    stateRoot,
    join(stateRoot, "state"),
    join(stateRoot, "journal"),
    join(stateRoot, "entities"),
    join(stateRoot, "entities", "people"),
    join(stateRoot, "entities", "projects"),
    join(stateRoot, "topics"),
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

interface JournalEntry {
  timestamp: string;
  topic: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function getRecentJournal(count: number): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const journalDir = getJournalDir();

  if (!existsSync(journalDir)) return entries;

  try {
    const files = readdirSync(journalDir)
      .filter((f) => f.endsWith(".jsonl"))
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
  } catch {
    // Ignore errors
  }

  return entries;
}

interface Schedule {
  id: string;
  type: "cron" | "once";
  expression: string;
  description: string;
  payload: string;
  createdAt: string;
}

function getSchedules(): Schedule[] {
  const remindersDir = getRemindersDir();
  if (!existsSync(remindersDir)) return [];

  const schedules: Schedule[] = [];
  try {
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
    return [];
  }
  return schedules;
}

interface FormatOptions {
  forCompaction?: boolean;
  client?: { config: { providers: () => Promise<{ data?: { providers?: Array<{ id: string; models?: Record<string, unknown> }> } }> } };
}

/**
 * Format memory context for injection into conversation
 */
export async function formatContextForPrompt(
  options: FormatOptions = {}
): Promise<string | null> {
  const { forCompaction = false, client } = options;
  const stateRoot = getStateRoot();
  const identityPath = join(stateRoot, "state", "identity.md");
  const isFirstRun = !existsSync(identityPath);

  // First run - return minimal context with onboarding pointer and detected user info
  if (isFirstRun) {
    if (forCompaction) return null;
    
    // Detect user info to avoid multiple permission prompts during onboarding
    const userInfo = detectUser();
    
    return `[MACRODATA]

## Status: First Run

Memory is not yet configured. Load the \`macrodata-onboarding\` skill to set up.

## Detected User Info

\`\`\`json
${JSON.stringify(userInfo, null, 2)}
\`\`\`

Use this pre-detected info during onboarding instead of running detection scripts.`;
  }

  const identity = readFileOrEmpty(identityPath);
  const today = readFileOrEmpty(join(stateRoot, "state", "today.md"));
  const human = readFileOrEmpty(join(stateRoot, "state", "human.md"));
  const workspace = readFileOrEmpty(join(stateRoot, "state", "workspace.md"));

  // Get recent journal
  const journalEntries = getRecentJournal(forCompaction ? 10 : 5);
  const journalFormatted = journalEntries
    .map((e) => {
      const ts = new Date(e.timestamp);
      const date = isNaN(ts.getTime()) ? "unknown" : ts.toISOString().split("T")[0];
      return `- [${e.topic}] ${e.content.split("\n")[0]} (${date})`;
    })
    .join("\n");

  // Get schedules
  const schedules = getSchedules();
  const schedulesFormatted =
    schedules.length > 0
      ? schedules
          .map((s) => `- ${s.description} (${s.type}: ${s.expression})`)
          .join("\n")
      : "_No active schedules_";

  const sections = [
    `<macrodata-identity>\n${identity || "_Not configured_"}\n</macrodata-identity>`,
    `<macrodata-today>\n${today || "_Empty_"}\n</macrodata-today>`,
    `<macrodata-human>\n${human || "_Empty_"}\n</macrodata-human>`,
  ];

  if (workspace) {
    sections.push(`<macrodata-workspace>\n${workspace}\n</macrodata-workspace>`);
  }

  sections.push(`<macrodata-journal>\n${journalFormatted || "_No entries_"}\n</macrodata-journal>`);

  if (!forCompaction) {
    sections.push(`<macrodata-schedules>\n${schedulesFormatted}\n</macrodata-schedules>`);

    // List state files
    const stateDir = join(stateRoot, "state");
    const stateFiles = existsSync(stateDir)
      ? readdirSync(stateDir).filter(f => f.endsWith(".md")).map(f => `state/${f}`)
      : [];

    // List entity files (scan all subdirs dynamically)
    const entitiesDir = join(stateRoot, "entities");
    const entityFiles: string[] = [];
    if (existsSync(entitiesDir)) {
      for (const subdir of readdirSync(entitiesDir)) {
        const dir = join(entitiesDir, subdir);
        try {
          if (!existsSync(dir) || !readdirSync(dir)) continue;
          for (const f of readdirSync(dir).filter(f => f.endsWith(".md"))) {
            entityFiles.push(`entities/${subdir}/${f}`);
          }
        } catch {
          // Skip non-directories
        }
      }
    }

    const allFiles = [...stateFiles, ...entityFiles];
    const filesFormatted = allFiles.length > 0
      ? allFiles.map(f => `- ${f}`).join("\n")
      : "_No files yet_";

    // Read usage from shared file
    const usagePath = new URL("../USAGE.md", import.meta.url).pathname;
    const usage = existsSync(usagePath) ? readFileSync(usagePath, "utf-8").trim() : "";

    if (usage) {
      sections.push(`<macrodata-usage>\n${usage}\n</macrodata-usage>`);
    }

    sections.push(
      `<macrodata-files root="${stateRoot}">\n${filesFormatted}\n</macrodata-files>`
    );

    // Fetch available models for scheduling tools
    if (client) {
      try {
        const { data } = await client.config.providers();
        if (data?.providers) {
          // Collect all models with toolcall capability, excluding dated versions
          type ModelInfo = { 
            id: string; 
            family?: string; 
            release_date?: string;
            capabilities?: { toolcall?: boolean };
          };
          const allModels: { fullId: string; family: string; releaseDate: string }[] = [];
          
          for (const provider of data.providers) {
            if (provider.models) {
              for (const [modelId, model] of Object.entries(provider.models)) {
                const m = model as ModelInfo;
                // Skip dated versions and models without toolcall
                if (/-\d{8}$/.test(modelId) || !m.capabilities?.toolcall) continue;
                
                allModels.push({
                  fullId: `${provider.id}/${modelId}`,
                  family: m.family || `${provider.id}/${modelId}`,
                  releaseDate: m.release_date || "1970-01-01",
                });
              }
            }
          }
          
          // Group by family and pick latest per family
          const byFamily = new Map<string, typeof allModels[0]>();
          for (const model of allModels) {
            const existing = byFamily.get(model.family);
            if (!existing || model.releaseDate > existing.releaseDate) {
              byFamily.set(model.family, model);
            }
          }
          
          const models = Array.from(byFamily.values()).map(m => m.fullId).sort();
          if (models.length > 0) {
            sections.push(`<macrodata-models>\nAvailable models for scheduling: ${models.join(", ")}\n</macrodata-models>`);
          }
        }
      } catch {
        // Ignore - models just won't be in context
      }
    }
  }

  return `<macrodata>\n${sections.join("\n\n")}\n</macrodata>`;
}

const sessionContextCache = new Map<string, string | null>();

/**
 * Get memory context for the system prompt, frozen per session.
 *
 * The system prompt sits at the start of the provider's cached prefix, so a
 * single changed byte re-ingests the whole conversation at cache-write prices.
 * State changes mid-session (journal writes, schedule edits) must reach the
 * conversation as message parts, never by mutating this snapshot.
 */
export async function getSessionContext(
  sessionID: string | undefined,
  options: FormatOptions = {}
): Promise<string | null> {
  if (!sessionID) {
    return formatContextForPrompt(options);
  }

  if (sessionContextCache.has(sessionID)) {
    return sessionContextCache.get(sessionID) ?? null;
  }

  const context = await formatContextForPrompt(options);
  sessionContextCache.set(sessionID, context);
  return context;
}

/**
 * Wrap volatile context in a synthetic text part attached to a user message.
 * At most one part is built per message, so the message-derived ID is unique.
 */
export function buildContextPart(
  text: string,
  message: { id: string; sessionID: string }
): TextPart {
  return {
    id: `${message.id}-macrodata`,
    messageID: message.id,
    sessionID: message.sessionID,
    type: "text",
    synthetic: true,
    text,
  };
}
