/**
 * Shared configuration utilities
 *
 * All paths are resolved dynamically (not cached at module load)
 * so that config changes take effect without restart.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const DEFAULT_ROOT = join(homedir(), ".config", "macrodata");
const DEFAULT_ENABLED_AGENTS = ["*"] as const;

interface MacrodataConfig {
  root?: unknown;
  enabled_agents?: unknown;
}

function readConfig(): MacrodataConfig | null {
  const configPath = join(DEFAULT_ROOT, "config.json");
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    if (raw && typeof raw === "object") {
      return raw as MacrodataConfig;
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Get the macrodata state root directory.
 * Priority: MACRODATA_ROOT env > ~/.config/macrodata/config.json > ~/.config/macrodata
 *
 * Resolved fresh each call so config changes take effect immediately.
 */
export function getStateRoot(): string {
  // Env var takes precedence (useful for testing/overrides)
  if (process.env.MACRODATA_ROOT) {
    return process.env.MACRODATA_ROOT;
  }

  const config = readConfig();
  if (config && typeof config.root === "string" && config.root.trim().length > 0) {
    const root = config.root.trim();
    // Expand ~ to home directory
    return root.startsWith("~/") ? join(homedir(), root.slice(2)) : root;
  }

  return DEFAULT_ROOT;
}

/**
 * Get the list of agent names that should receive macrodata context.
 *
 * Special values:
 * - "default": primary sessions (no explicit agent name)
 * - "*": all agents
 */
export function getEnabledAgents(): string[] {
  const config = readConfig();
  if (!config || !Array.isArray(config.enabled_agents)) {
    return [...DEFAULT_ENABLED_AGENTS];
  }

  const enabledAgents = config.enabled_agents
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  return enabledAgents;
}

export function getStateDir(): string {
  return join(getStateRoot(), "state");
}

export function getEntitiesDir(): string {
  return join(getStateRoot(), "entities");
}

export function getJournalDir(): string {
  return join(getStateRoot(), "journal");
}

export function getSignalsDir(): string {
  return join(getStateRoot(), "signals");
}

export function getIndexDir(): string {
  return join(getStateRoot(), ".index");
}

export function getTopicsDir(): string {
  return join(getStateRoot(), "topics");
}

export function getRemindersDir(): string {
  return join(getStateRoot(), "reminders");
}
