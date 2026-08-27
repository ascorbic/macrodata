/**
 * OpenCode Macrodata Plugin
 *
 * Provides persistent local memory for OpenCode agents:
 * - Session-stable context injection via system prompt transform
 * - Daemon deltas and state changes injected as user message parts
 * - Compaction hook to preserve memory context
 * - Custom `macrodata` tool for memory operations
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, openSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { memoryTools } from "./tools.js";
import { formatContextForPrompt, getSessionContext, getContextUpdate, buildContextPart, consumePendingContext, initializeStateRoot, getStateRoot } from "./context.js";
import { logger } from "./logger.js";


/**
 * Check if a process with given PID is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Send SIGHUP to the daemon to reload config
 */
function signalDaemonReload(): void {
  const pidFile = join(homedir(), ".config", "macrodata", ".daemon.pid");
  if (!existsSync(pidFile)) return;

  try {
    const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isProcessRunning(pid)) {
      process.kill(pid, "SIGHUP");
    }
  } catch {
    // Ignore errors
  }
}

const HEARTBEAT_STALE_MS = 15 * 60_000;

/**
 * Ensure the macrodata daemon is running and healthy.
 * Starts it when the PID is dead, and restarts it when the PID is alive but
 * the heartbeat file is stale (wedged daemon, see #25).
 */
function ensureDaemonRunning(): void {
  const configDir = join(homedir(), ".config", "macrodata");
  const pidFile = join(configDir, ".daemon.pid");
  const stateRoot = getStateRoot();
  const heartbeatFile = join(stateRoot, ".daemon.heartbeat");
  const daemonScript = join(import.meta.dirname, "..", "bin", "macrodata-daemon.ts");

  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (isProcessRunning(pid)) {
        if (!isHeartbeatStale(heartbeatFile)) {
          return;
        }
        logger.warn(`Daemon PID ${pid} alive but heartbeat stale, restarting`);
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // Already gone
        }
      }
    } catch {
      // Invalid PID file, continue to start daemon
    }
  }

  // Start daemon - it writes its own PID file
  try {
    // Ensure config dir exists for PID file
    mkdirSync(configDir, { recursive: true });
    
    const logFile = join(getStateRoot(), ".daemon.log");
    const out = openSync(logFile, "a");
    const err = openSync(logFile, "a");
    
    const child = spawn("bun", ["run", daemonScript], {
      detached: true,
      stdio: ["ignore", out, err],
      env: { ...process.env, MACRODATA_ROOT: stateRoot },
    });
    child.unref();
  } catch (err) {
    logger.error(`Failed to start daemon: ${String(err)}`);
  }
}

function isHeartbeatStale(heartbeatFile: string): boolean {
  if (!existsSync(heartbeatFile)) {
    return false;
  }
  try {
    const lastBeat = parseInt(readFileSync(heartbeatFile, "utf-8").trim(), 10);
    return Number.isFinite(lastBeat) && Date.now() - lastBeat > HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

/**
 * Install plugin skills to ~/.config/opencode/skills/
 * Skills are copied from the plugin's skills directory on first load
 */
function installSkills(): void {
  const globalSkillsDir = join(homedir(), ".config", "opencode", "skills");
  // import.meta.dirname is the opencode/ folder
  const pluginSkillsDir = join(import.meta.dirname, "skills");

  if (!existsSync(pluginSkillsDir)) {
    return;
  }

  // Ensure global skills directory exists
  if (!existsSync(globalSkillsDir)) {
    mkdirSync(globalSkillsDir, { recursive: true });
  }

  // Copy each skill directory
  const skills = readdirSync(pluginSkillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const skill of skills) {
    const src = join(pluginSkillsDir, skill);
    const dest = join(globalSkillsDir, skill);
    
    // Always update skills (overwrite existing)
    try {
      cpSync(src, dest, { recursive: true });
    } catch {
      // Silently fail - non-critical
    }
  }
}

export const MacrodataPlugin: Plugin = async (ctx: PluginInput) => {
  // Initialize state directories
  initializeStateRoot();

  // Ensure daemon is running for scheduled reminders
  ensureDaemonRunning();

  // Signal daemon to reload config (in case it was started with old config)
  signalDaemonReload();

  // Install skills to global config on plugin load
  installSkills();

  return {
    // Inject memory context into the system prompt, frozen per session so the
    // provider's prompt cache stays valid across turns
    "experimental.chat.system.transform": async (input, output) => {
      try {
        const memoryContext = await getSessionContext(input.sessionID, { client: ctx.client });
        if (memoryContext) {
          output.system.push(memoryContext);
        }
      } catch (err) {
        logger.error(`System context injection error: ${String(err)}`);
      }
    },

    // Deliver daemon deltas and state changes as a part of the incoming user
    // message — appended to the transcript tail, so the cached prefix is
    // untouched
    "chat.message": async (input, output) => {
      try {
        const updates: string[] = [];

        const pendingContext = consumePendingContext();
        if (pendingContext) {
          updates.push(pendingContext);
        }

        const contextUpdate = await getContextUpdate(input.sessionID);
        if (contextUpdate) {
          updates.push(contextUpdate);
        }

        if (updates.length > 0) {
          output.parts.push(buildContextPart(updates.join("\n\n"), output.message));
        }
      } catch (err) {
        logger.error(`Context update injection error: ${String(err)}`);
      }
    },

    // Inject memory context before compaction
    "experimental.session.compacting": async (_input, output) => {
      try {
        const memoryContext = await formatContextForPrompt({ forCompaction: true });

        if (memoryContext) {
          output.context.push(memoryContext);
        }
      } catch (err) {
        logger.error(`Compaction hook error: ${String(err)}`);
      }
    },

    // Provide memory tools
    tool: memoryTools,
  };
};

// Default export for OpenCode plugin system
export default MacrodataPlugin;
