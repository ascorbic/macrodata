/**
 * Spike config — paths only.
 *
 * Reads macrodata's markdown from the LIVE root but writes its OWN index inside
 * the spike dir, so a rebuild here can never dim-mismatch the live MiniLM/384
 * MCP server. Override the data root with MACRODATA_ROOT.
 */

import { join } from "path";
import { homedir } from "os";

export function getMacrodataRoot(): string {
  return process.env.MACRODATA_ROOT || join(homedir(), "Documents", "macrodata");
}

export function getJournalDir(): string {
  return join(getMacrodataRoot(), "journal");
}

export function getEntitiesDir(): string {
  return join(getMacrodataRoot(), "entities");
}

// Spike index lives INSIDE the spike dir — fully isolated from the live .index.
export function getIndexDir(): string {
  return join(import.meta.dir, ".index");
}
