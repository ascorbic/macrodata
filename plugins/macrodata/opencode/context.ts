/**
 * Context formatting for OpenCode plugin
 *
 * Reads state files and formats them for injection into conversations
 */

import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from "fs";

import { join } from "path";
import { getStateRoot, getJournalDir, getSchedulesFile } from "../src/config.js";
import { detectUser } from "../src/detect-user.js";

// Track lastmod times per session
const sessionLastmod = new Map<string, Record<string, number>>();

function getStateFilePaths(): string[] {
  const stateRoot = getStateRoot();
  return [
    join(stateRoot, "state", "identity.md"),
    join(stateRoot, "state", "today.md"),
    join(stateRoot, "state", "human.md"),
    join(stateRoot, "state", "workspace.md"),
  ];
}

function getCurrentLastmod(): Record<string, number> {
  const result: Record<string, number> = {};
  for (const path of getStateFilePaths()) {
    try {
      if (existsSync(path)) {
        result[path] = statSync(path).mtimeMs;
      }
    } catch {
      // Ignore
    }
  }
  return result;
}

export function storeLastmod(sessionId: string): void {
  sessionLastmod.set(sessionId, getCurrentLastmod());
}

export function checkFilesChanged(sessionId: string): boolean {
  const stored = sessionLastmod.get(sessionId);
  if (!stored) return true; // No stored lastmod, treat as changed

  const current = getCurrentLastmod();
  for (const path of getStateFilePaths()) {
    if (current[path] !== stored[path]) {
      return true;
    }
  }
  return false;
}

// Re-export for compatibility
export { getStateRoot } from "../src/config.js";

/**
 * Initialize state directory with default structure
 */
export function initializeStateRoot(): void {
  const stateRoot = getStateRoot();
  
  // Create directories
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
  
  // Create default files if they don't exist
  const identityPath = join(stateRoot, "state", "identity.md");
  if (!existsSync(identityPath)) {
    writeFileSync(identityPath, `# Identity

You are a coding assistant with persistent memory. Use your memory tools to:
- Log important observations with \`log_journal\`
- Search past context with \`search_memory\`
- Save session summaries with \`save_conversation_summary\`
`);
  }
  
  const todayPath = join(stateRoot, "state", "today.md");
  if (!existsSync(todayPath)) {
    const today = new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    writeFileSync(todayPath, `# Today – ${today}

## Priorities

_Add your priorities here_

## Notes

_Session notes_
`);
  }
  
  const humanPath = join(stateRoot, "state", "human.md");
  if (!existsSync(humanPath)) {
    writeFileSync(humanPath, `# Human

_Add information about yourself here_
`);
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
  const schedulesFile = getSchedulesFile();
  if (!existsSync(schedulesFile)) return [];

  try {
    const data = JSON.parse(readFileSync(schedulesFile, "utf-8"));
    return data.schedules || [];
  } catch {
    return [];
  }
}

interface FormatOptions {
  forCompaction?: boolean;
}

/**
 * Format memory context for injection into conversation
 */
export async function formatContextForPrompt(
  options: FormatOptions = {}
): Promise<string | null> {
  const { forCompaction = false } = options;
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

Memory is not yet configured. Load the \`onboarding\` skill to set up.

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
      const date = new Date(e.timestamp).toLocaleDateString();
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
    `## Identity\n\n${identity || "_Not configured_"}`,
    `## Today\n\n${today || "_Empty_"}`,
    `## Human\n\n${human || "_Empty_"}`,
  ];

  if (workspace) {
    sections.push(`## Workspace\n\n${workspace}`);
  }

  sections.push(`## Recent Journal\n\n${journalFormatted || "_No entries_"}`);

  if (!forCompaction) {
    sections.push(`## Schedules\n\n${schedulesFormatted}`);
    sections.push(
      `## Paths\n\n- Root: \`${stateRoot}\`\n- State: \`${join(stateRoot, "state")}\`\n- Journal: \`${getJournalDir()}\``
    );
  }

  return `[MACRODATA]\n\n${sections.join("\n\n")}`;
}
