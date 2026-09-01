/**
 * Ambient-recall paths.
 *
 * Reads the same markdown corpus as the MCP server but keeps its own Vectra
 * index: this side embeds with Qwen3-Embedding-0.6B (1024-dim) while the MCP
 * server uses MiniLM (384-dim), so a shared index dir would dim-mismatch on the
 * first rebuild either one ran.
 *
 * All recall state lives under a single dotdir at the state root. The root's
 * .gitignore ignores every root-level dotfile (`/.*`) on the rule that dotfiles
 * are regenerable runtime and plain dirs are memory content — so `.recall/`
 * stays out of the user's memory history without a .gitignore edit, and must
 * keep its leading dot to stay that way.
 */

import { join } from "path";
import { getStateRoot } from "../config.ts";

export { getStateRoot, getEntitiesDir, getJournalDir } from "../config.ts";

/** Alias kept for recall entry points that predate the shared resolver. */
export const getMacrodataRoot = getStateRoot;

/** Root of all ambient-recall runtime state. */
export function getRecallDir(): string {
  return join(getStateRoot(), ".recall");
}

/** Qwen3/1024 index — deliberately NOT the MCP server's MiniLM/384 `.index/`. */
export function getIndexDir(): string {
  return join(getRecallDir(), "index");
}

/**
 * Per-session mailbox. The hook writes `request-<sid>.json` and reads
 * `inbox-<sid>.json`; the worker drains the reverse. Session-scoped names let a
 * stale file be traced back to the session that orphaned it.
 */
export function getMailboxDir(): string {
  return join(getRecallDir(), "mailbox");
}

export function getRequestPath(sid: string): string {
  return join(getMailboxDir(), `request-${sid}.json`);
}

export function getInboxPath(sid: string): string {
  return join(getMailboxDir(), `inbox-${sid}.json`);
}

/** Chunks this session already injected — the dedupe baseline for the next fire. */
export function getInjectedPath(sid: string): string {
  return join(getMailboxDir(), `injected-${sid}.json`);
}

/** Window-scoped exclusions the hook computes for the worker to honor. */
export function getExcludePath(sid: string): string {
  return join(getMailboxDir(), `exclude-${sid}.json`);
}

/**
 * Spawn-time mutex for the worker, claimed exclusively at startup.
 *
 * Liveness is answered by `ps` — macrodata-hook.sh matches the argv sentinel —
 * so this file never decides whether a worker is running. It exists only so that
 * a burst of spawns settles on one survivor.
 */
export function getWorkerPidPath(): string {
  return join(getRecallDir(), "worker.pid");
}

/**
 * Where macrodata-hook.sh records each worker start it could not later find.
 *
 * The worker clears it once it holds the slot, which is what makes the file a
 * count of FAILED starts rather than of starts: a start that leaves a worker
 * running erases its own line, so anything left is a start that produced
 * nothing, and the hook reports a broken install off the length.
 */
export function getSpawnStampPath(): string {
  return join(getRecallDir(), "last-spawn");
}

export function getCalibrationLog(): string {
  return join(getRecallDir(), "calibration.jsonl");
}

export function getAccessLog(): string {
  return join(getRecallDir(), "access-events.jsonl");
}

export function getLogPath(name: string): string {
  return join(getRecallDir(), `${name}.log`);
}
