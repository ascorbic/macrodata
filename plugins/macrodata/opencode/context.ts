/**
 * Context formatting for OpenCode plugin
 *
 * Reads state files and formats them for injection into conversations
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";

import { join } from "path";
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

function getRecentJournal(
  count: number,
  _topic?: string,
  options: { mode?: "summary" | "full"; maxChars?: number } = {}
): JournalEntry[] {
  const mode = options.mode || "summary";
  const maxChars = options.maxChars ?? 200;
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

  if (mode === "summary") {
    return entries.map((entry) => {
      const compact = entry.content.replace(/\s+/g, " ").trim();
      const summary = compact.length <= maxChars ? compact : `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
      return {
        ...entry,
        content: summary,
      };
    });
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
    const files = readdirSync(remindersDir)
      .filter((f) => f.endsWith(".json"))
      .sort();
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

interface SectionCache {
  content: string;
  hash: string;
}

interface ModelsCache {
  content: string;
  fetchedAt: number;
}

interface ContextCache {
  identity: SectionCache | null;
  today: SectionCache | null;
  state: SectionCache | null;
  workspace: SectionCache | null;
  schedules: SectionCache | null;
  journal: SectionCache | null;
  human: SectionCache | null;
  usage: string | null;
  files: string | null;
  models: ModelsCache | null;
  turnCount: number;
  lastCompactionAt: number;
}

const MODELS_TTL_MS = 30 * 60 * 1000;
const LIVE_TOKEN_BUDGET = 1000;
const COMPACTION_TOKEN_BUDGET = 1500;

// KNOWN: module-level cache persists across sessions in the same process.
const cache: ContextCache = {
  identity: null,
  today: null,
  state: null,
  workspace: null,
  schedules: null,
  journal: null,
  human: null,
  usage: null,
  files: null,
  models: null,
  turnCount: 0,
  lastCompactionAt: -1,
};

function hashContent(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}

function diffSection(
  key: "identity" | "today" | "state" | "workspace" | "schedules" | "journal" | "human",
  rawContent: string,
  render: () => string,
): string | null {
  const hash = hashContent(rawContent);
  if (cache[key]?.hash === hash) return null;
  const content = render();
  cache[key] = { content, hash };
  return content;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function extractStub(content: string, fallback: string): string {
  const trimmed = content.trim();
  if (!trimmed) return fallback;

  const paragraphs = trimmed
    .split("\n\n")
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^#{1,6}\s+/.test(part));

  const candidate = paragraphs[0] || trimmed;
  const compact = candidate
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !/^#{1,6}\s+/.test(line))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return fallback;
  if (compact.length <= 220) return compact;
  return `${compact.slice(0, 217)}...`;
}

function extractSection(content: string, heading: string): string | null {
  const pattern = new RegExp(`##\\s*${heading}\\s*\\n([\\s\\S]*?)(?:\\n##\\s|$)`, "i");
  const match = content.match(pattern);
  return match?.[1]?.trim() || null;
}

function extractFirstBullet(sectionContent: string): string | null {
  const lines = sectionContent
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  for (const line of lines) {
    if (line.startsWith("- ")) {
      return line.slice(2).trim();
    }
  }

  return null;
}

function extractHumanStub(content: string): string {
  if (!content.trim()) return "_Unknown_";

  const name = content.match(/^\s*-\s*\*\*Name:\*\*\s*(.+)$/m)?.[1]?.trim();
  const timezone = content.match(/^\s*-\s*\*\*Timezone:\*\*\s*(.+)$/m)?.[1]?.trim();
  const locationSection = extractSection(content, "Location");
  const location = locationSection ? extractFirstBullet(locationSection) : null;

  const parts = [
    name ? `Name: ${name}` : null,
    timezone ? `Timezone: ${timezone}` : null,
    location ? `Location: ${location}` : null,
  ].filter(Boolean);

  if (parts.length > 0) {
    return parts.join(" | ");
  }

  return extractStub(content, "_Unknown_");
}

function ensureAnchoredStateFile(stateRoot: string): void {
  const anchoredStatePath = join(stateRoot, "state", "state.md");
  if (existsSync(anchoredStatePath)) return;

  const template = [
    "## Current Focus",
    "- _Not set_",
    "",
    "## Active Investigations",
    "- _None_",
    "",
    "## Open Threads",
    "- _None_",
    "",
    "## Key Decisions",
    "- _None_",
    "",
  ].join("\n");

  try {
    writeFileSync(anchoredStatePath, template);
  } catch {
    // Ignore write failures.
  }
}

function renderJournal(entries: JournalEntry[]): string {
  return entries
    .map((entry) => {
      const ts = new Date(entry.timestamp);
      const date = isNaN(ts.getTime()) ? "unknown" : ts.toLocaleDateString();
      return `- [${entry.topic}] ${entry.content.split("\n")[0]} (${date})`;
    })
    .join("\n");
}

function renderSchedules(schedules: Schedule[]): string {
  if (schedules.length === 0) return "_No active schedules_";
  return schedules
    .map((schedule) => `- ${schedule.description} (${schedule.type}: ${schedule.expression})`)
    .join("\n");
}

function buildFilesSection(stateRoot: string): string {
  const stateDir = join(stateRoot, "state");
  const stateFiles = existsSync(stateDir)
    ? readdirSync(stateDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .map((f) => `state/${f}`)
    : [];

  const entitiesDir = join(stateRoot, "entities");
  const entityFiles: string[] = [];
  if (existsSync(entitiesDir)) {
    const subdirs = readdirSync(entitiesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();

    for (const subdir of subdirs) {
      const dir = join(entitiesDir, subdir);
      try {
        const files = readdirSync(dir)
          .filter((f) => f.endsWith(".md"))
          .sort();
        for (const file of files) {
          entityFiles.push(`entities/${subdir}/${file}`);
        }
      } catch {
        // Ignore unreadable subdirectories.
      }
    }
  }

  const allFiles = [...stateFiles, ...entityFiles];
  if (allFiles.length === 0) return "_No files yet_";
  return allFiles.map((file) => `- ${file}`).join("\n");
}

async function getModelsSectionSafe(
  client?: FormatOptions["client"],
): Promise<string> {
  const now = Date.now();
  if (cache.models && now - cache.models.fetchedAt < MODELS_TTL_MS) {
    return cache.models.content;
  }
  if (!client) return cache.models?.content ?? "";

  try {
    const { data } = await client.config.providers();
    if (!data?.providers) {
      cache.models = { content: "", fetchedAt: now };
      return "";
    }

    type ModelInfo = {
      family?: string;
      release_date?: string;
      capabilities?: { toolcall?: boolean };
    };

    const allModels: { fullId: string; family: string; releaseDate: string }[] = [];
    for (const provider of data.providers) {
      if (!provider.models) continue;
      for (const [modelId, model] of Object.entries(provider.models)) {
        const current = model as ModelInfo;
        if (/-\d{8}$/.test(modelId) || !current.capabilities?.toolcall) continue;
        allModels.push({
          fullId: `${provider.id}/${modelId}`,
          family: current.family || `${provider.id}/${modelId}`,
          releaseDate: current.release_date || "1970-01-01",
        });
      }
    }

    const byFamily = new Map<string, (typeof allModels)[0]>();
    for (const model of allModels) {
      const existing = byFamily.get(model.family);
      if (!existing || model.releaseDate > existing.releaseDate) {
        byFamily.set(model.family, model);
      }
    }

    const models = Array.from(byFamily.values())
      .map((model) => model.fullId)
      .sort();

    const content =
      models.length > 0
        ? `<macrodata-models>\nAvailable models for scheduling: ${models.join(", ")}\n</macrodata-models>`
        : "";
    cache.models = { content, fetchedAt: now };
    return content;
  } catch {
    return cache.models?.content ?? "";
  }
}

/**
 * Format memory context for injection into conversation
 */
export async function formatContextBlocksForPrompt(
  options: FormatOptions = {}
): Promise<{ staticContext: string | null; dynamicContext: string | null }> {
  const { forCompaction = false, client } = options;
  const stateRoot = getStateRoot();
  const identityPath = join(stateRoot, "state", "identity.md");
  const isFirstRun = !existsSync(identityPath);

  // First run - return minimal context with onboarding pointer and detected user info
  if (isFirstRun) {
    if (forCompaction) {
      return { staticContext: null, dynamicContext: null };
    }
    
    // Detect user info to avoid multiple permission prompts during onboarding
    const userInfo = detectUser();
    
    return {
      staticContext: `[MACRODATA]

## Status: First Run

Memory is not yet configured. Load the \`macrodata-onboarding\` skill to set up.

## Detected User Info

\`\`\`json
${JSON.stringify(userInfo, null, 2)}
\`\`\`

Use this pre-detected info during onboarding instead of running detection scripts.`,
      dynamicContext: null,
    };
  }

  ensureAnchoredStateFile(stateRoot);

  if (forCompaction) {
    cache.human = null;
    cache.usage = null;
    cache.files = null;
    cache.lastCompactionAt = cache.turnCount;
  }

  cache.turnCount += 1;
  const isFirstTurn = cache.turnCount === 1;
  const isPostCompaction = cache.lastCompactionAt === cache.turnCount - 1;
  const injectStatics = forCompaction || isFirstTurn || isPostCompaction;
  const tokenBudget = forCompaction ? COMPACTION_TOKEN_BUDGET : LIVE_TOKEN_BUDGET;
  let tokenCount = 0;

  const staticSections: string[] = [];
  const dynamicSections: string[] = [];
  const appendSection = (
    destination: "static" | "dynamic",
    content: string,
    mandatory = false,
  ): void => {
    const sectionTokens = estimateTokens(content);
    if (!mandatory && tokenCount + sectionTokens > tokenBudget) {
      return;
    }
    if (destination === "static") {
      staticSections.push(content);
    } else {
      dynamicSections.push(content);
    }
    tokenCount += sectionTokens;
  };

  const identity = readFileOrEmpty(identityPath);
  const today = readFileOrEmpty(join(stateRoot, "state", "today.md"));
  const anchoredState = readFileOrEmpty(join(stateRoot, "state", "state.md"));
  const human = readFileOrEmpty(join(stateRoot, "state", "human.md"));

  appendSection(
    "static",
    `<macrodata-identity-stub>\n${extractStub(identity, "_Not configured_")}\n</macrodata-identity-stub>`,
    true,
  );
  appendSection(
    "static",
    `<macrodata-today-stub>\n${extractStub(today, "_Empty_")}\n</macrodata-today-stub>`,
    true,
  );
  appendSection(
    "static",
    `<macrodata-human-stub>\n${extractHumanStub(human)}\n</macrodata-human-stub>`,
    true,
  );

  const identitySection = diffSection("identity", identity, () => {
    return `<macrodata-identity>\n${identity || "_Not configured_"}\n</macrodata-identity>`;
  });
  if (injectStatics && cache.identity?.content) {
    appendSection("static", cache.identity.content);
  } else if (identitySection) {
    appendSection("dynamic", identitySection);
  }

  const todaySection = diffSection("today", today, () => {
    return `<macrodata-today>\n${today || "_Empty_"}\n</macrodata-today>`;
  });
  if (injectStatics && cache.today?.content) {
    appendSection("static", cache.today.content);
  } else if (todaySection) {
    appendSection("dynamic", todaySection);
  }

  const stateSection = diffSection("state", anchoredState, () => {
    return `<macrodata-state>\n${anchoredState || "_Empty_"}\n</macrodata-state>`;
  });
  if (injectStatics && cache.state?.content) {
    appendSection("static", cache.state.content);
  } else if (stateSection) {
    appendSection("dynamic", stateSection);
  }

  const humanSection = diffSection("human", human, () => {
    return `<macrodata-human>\n${human || "_Empty_"}\n</macrodata-human>`;
  });
  if (injectStatics && cache.human?.content) {
    appendSection("static", cache.human.content, true);
  } else if (humanSection) {
    appendSection("dynamic", humanSection);
  }

  if (injectStatics) {
    if (!forCompaction) {
      if (cache.usage === null) {
        const usagePath = new URL("../USAGE.md", import.meta.url).pathname;
        cache.usage = existsSync(usagePath) ? readFileSync(usagePath, "utf-8").trim() : "";
      }
      if (cache.usage) {
        appendSection("static", `<macrodata-usage>\n${cache.usage}\n</macrodata-usage>`);
      }

      if (cache.files === null) {
        cache.files = buildFilesSection(stateRoot);
      }
      appendSection("static", `<macrodata-files root="${stateRoot}">\n${cache.files}\n</macrodata-files>`);

      const modelsSection = await getModelsSectionSafe(client);
      if (modelsSection) {
        appendSection("static", modelsSection);
      }
    }
  }

  const workspace = readFileOrEmpty(join(stateRoot, "state", "workspace.md"));
  const workspaceSection = diffSection("workspace", workspace, () => {
    return `<macrodata-workspace>\n${workspace || "_Empty_"}\n</macrodata-workspace>`;
  });
  if (injectStatics && cache.workspace?.content) {
    appendSection("static", cache.workspace.content);
  } else if (workspaceSection) {
    appendSection("dynamic", workspaceSection);
  }

  const journalEntries = getRecentJournal(forCompaction ? 10 : 5, undefined, {
    mode: forCompaction ? "full" : "summary",
    maxChars: 200,
  });
  const journalRaw = JSON.stringify(journalEntries);
  const journalSection = diffSection("journal", journalRaw, () => {
    const renderedJournal = renderJournal(journalEntries);
    return `<macrodata-journal>\n${renderedJournal || "_No entries_"}\n</macrodata-journal>`;
  });
  if (injectStatics && cache.journal?.content) {
    appendSection("static", cache.journal.content);
  } else if (journalSection) {
    appendSection("dynamic", journalSection);
  }

  if (!forCompaction) {
    const schedules = getSchedules();
    const schedulesRaw = JSON.stringify(schedules);
    const schedulesSection = diffSection("schedules", schedulesRaw, () => {
      return `<macrodata-schedules>\n${renderSchedules(schedules)}\n</macrodata-schedules>`;
    });
    if (injectStatics && cache.schedules?.content) {
      appendSection("static", cache.schedules.content);
    } else if (schedulesSection) {
      appendSection("dynamic", schedulesSection);
    }
  }

  const staticContext =
    staticSections.length > 0
      ? `<macrodata section="static">\n${staticSections.join("\n\n")}\n</macrodata>`
      : null;
  const dynamicContext =
    dynamicSections.length > 0
      ? `<macrodata section="dynamic">\n${dynamicSections.join("\n\n")}\n</macrodata>`
      : null;

  return { staticContext, dynamicContext };
}

export async function formatContextForPrompt(
  options: FormatOptions = {}
): Promise<string | null> {
  const { staticContext, dynamicContext } = await formatContextBlocksForPrompt(options);
  if (staticContext && dynamicContext) {
    return `<macrodata>\n${staticContext}\n\n${dynamicContext}\n</macrodata>`;
  }
  if (staticContext) {
    return `<macrodata>\n${staticContext}\n</macrodata>`;
  }
  if (dynamicContext) {
    return `<macrodata>\n${dynamicContext}\n</macrodata>`;
  }
  return null;
}
