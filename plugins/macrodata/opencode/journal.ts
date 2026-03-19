/**
 * Journal operations for OpenCode plugin
 *
 * Write journal entries and search memory
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { getStateRoot } from "./context.js";
import { indexJournalEntry } from "./search.js";
import { logger } from "./logger.js";

interface JournalEntry {
  timestamp: string;
  topic: string;
  content: string;
  metadata?: {
    source?: string;
    intent?: string;
  };
}

function ensureDirectories(): void {
  const stateRoot = getStateRoot();
  const dirs = [
    stateRoot,
    join(stateRoot, "state"),
    join(stateRoot, "entities"),
    join(stateRoot, "entities", "people"),
    join(stateRoot, "entities", "projects"),
    join(stateRoot, "journal"),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

function getTodayJournalPath(): string {
  const stateRoot = getStateRoot();
  const today = new Date().toISOString().split("T")[0];
  return join(stateRoot, "journal", `${today}.jsonl`);
}

/**
 * Log an entry to the journal
 */
export async function logJournal(
  topic: string,
  content: string,
  metadata?: { source?: string; intent?: string }
): Promise<void> {
  ensureDirectories();

  const entry: JournalEntry = {
    timestamp: new Date().toISOString(),
    topic,
    content,
    metadata: metadata || { source: "opencode-plugin" },
  };

  const journalPath = getTodayJournalPath();
  appendFileSync(journalPath, JSON.stringify(entry) + "\n");

  // Index the entry for semantic search
  try {
    await indexJournalEntry(entry);
  } catch (err) {
    logger.error(`Failed to index journal entry: ${String(err)}`);
  }
}

/**
 * Get recent journal entries
 */
export function getRecentJournal(
  count: number,
  topic?: string,
  options: { mode?: "summary" | "full"; maxChars?: number } = {}
): JournalEntry[] {
  const mode = options.mode || "full";
  const maxChars = options.maxChars ?? 200;
  const stateRoot = getStateRoot();
  const journalDir = join(stateRoot, "journal");
  let entries: JournalEntry[] = [];

  if (!existsSync(journalDir)) return entries;

  try {
    const files = readdirSync(journalDir)
      .filter((f) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    for (const file of files) {
      if (entries.length >= count * 2) break; // Get more for filtering

      const content = readFileSync(join(journalDir, file), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      for (const line of lines.reverse()) {
        try {
          const entry = JSON.parse(line) as JournalEntry;
          entries.push(entry);
        } catch {
          // Skip malformed lines
        }
      }
    }
  } catch {
    // Ignore errors
  }

  // Filter by topic if specified
  if (topic) {
    entries = entries.filter((e) => e.topic === topic);
  }

  if (mode === "summary") {
    entries = entries.map((entry) => {
      const compact = entry.content.replace(/\s+/g, " ").trim();
      const summary = compact.length <= maxChars ? compact : `${compact.slice(0, Math.max(0, maxChars - 3))}...`;
      return {
        ...entry,
        content: summary,
      };
    });
  }

  return entries.slice(0, count);
}

function upsertSection(markdown: string, heading: string, bodyLines: string[]): string {
  const sectionHeader = `## ${heading}`;
  const newBody = bodyLines.join("\n").trim();
  const replacement = `${sectionHeader}\n${newBody}`;
  const escapedHeader = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const sectionRegex = new RegExp(`(^## ${escapedHeader}\\n[\\s\\S]*?)(?=\\n## |$)`, "m");

  if (sectionRegex.test(markdown)) {
    return markdown.replace(sectionRegex, replacement);
  }

  const trimmed = markdown.trim();
  if (!trimmed) return replacement;
  return `${trimmed}\n\n${replacement}`;
}

function updateAnchoredState(options: {
  summary: string;
  keyDecisions?: string[];
  openThreads?: string[];
}): void {
  const stateRoot = getStateRoot();
  const statePath = join(stateRoot, "state", "state.md");
  const existing = existsSync(statePath) ? readFileSync(statePath, "utf-8") : "";

  let next = upsertSection(existing, "Current Focus", [
    `- ${options.summary.replace(/\s+/g, " ").trim().slice(0, 180) || "_Not set_"}`,
  ]);

  if (options.openThreads?.length) {
    next = upsertSection(
      next,
      "Open Threads",
      options.openThreads.map((thread) => `- ${thread}`),
    );
  }

  if (options.keyDecisions?.length) {
    next = upsertSection(
      next,
      "Key Decisions",
      options.keyDecisions.map((decision) => `- ${decision}`),
    );
  }

  writeFileSync(statePath, `${next.trim()}\n`);
}

/**
 * Get recent conversation summaries
 */
export function getRecentSummaries(count: number): JournalEntry[] {
  return getRecentJournal(count, "conversation-summary", { mode: "summary" });
}

/**
 * Save a conversation summary
 */
export async function saveConversationSummary(options: {
  summary: string;
  keyDecisions?: string[];
  openThreads?: string[];
  learnedPatterns?: string[];
  notes?: string;
}): Promise<void> {
  const parts = [options.summary];

  if (options.keyDecisions?.length) {
    parts.push(`Decisions: ${options.keyDecisions.join(", ")}`);
  }
  if (options.openThreads?.length) {
    parts.push(`Open threads: ${options.openThreads.join(", ")}`);
  }
  if (options.learnedPatterns?.length) {
    parts.push(`Learned: ${options.learnedPatterns.join(", ")}`);
  }
  if (options.notes) {
    parts.push(`Notes: ${options.notes}`);
  }

  await logJournal("conversation-summary", parts.join("\n"), {
    source: "opencode-plugin",
  });

  try {
    updateAnchoredState(options);
  } catch (err) {
    logger.error(`Failed to update anchored state: ${String(err)}`);
  }
}
