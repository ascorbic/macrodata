/**
 * Context formatting for OpenCode plugin
 *
 * Reads state files and formats them for injection into conversations
 */

import { existsSync, readFileSync, readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Configuration
export function getStateRoot(): string {
  // Check for env var first (set by user config)
  if (process.env.MACRODATA_ROOT) {
    return process.env.MACRODATA_ROOT;
  }

  // Check for config file
  const configPath = join(homedir(), ".config", "opencode", "macrodata.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.root) return config.root;
    } catch {
      // Ignore parse errors
    }
  }

  // Default
  return join(homedir(), ".config", "macrodata");
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
  const stateRoot = getStateRoot();
  const journalDir = join(stateRoot, "journal");
  const entries: JournalEntry[] = [];

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
  const stateRoot = getStateRoot();
  const schedulesFile = join(stateRoot, ".schedules.json");

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

  // Check if configured
  const identityPath = join(stateRoot, "identity.md");
  if (!existsSync(identityPath)) {
    if (!forCompaction) {
      return `[MACRODATA]

Memory not configured. Set MACRODATA_ROOT environment variable or create ~/.config/opencode/macrodata.json with {"root": "/path/to/state"}`;
    }
    return null;
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
      `## Paths\n\n- Root: \`${stateRoot}\`\n- State: \`${join(stateRoot, "state")}\`\n- Journal: \`${join(stateRoot, "journal")}\``
    );
  }

  return `[MACRODATA]\n\n${sections.join("\n\n")}`;
}
