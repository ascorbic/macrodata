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

  // Check config file in default location
  const configPath = join(DEFAULT_ROOT, "config.json");
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      if (config.root) return config.root;
    } catch {
      // Ignore parse errors
    }
  }

  return DEFAULT_ROOT;
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

export function getSchedulesFile(): string {
  return join(getStateRoot(), ".schedules.json");
}
