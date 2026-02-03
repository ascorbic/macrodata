/**
 * OpenCode Macrodata Plugin
 *
 * Provides persistent local memory for OpenCode agents:
 * - Context injection on first message
 * - Compaction hook to preserve memory context
 * - Auto-journaling of git commands and file changes
 * - Custom `macrodata` tool for memory operations
 */

import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import type { Part } from "@opencode-ai/sdk";
import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, openSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { spawn } from "child_process";
import { memoryTools } from "./tools.js";
import { formatContextForPrompt, storeLastmod, checkFilesChanged, initializeStateRoot, getStateRoot } from "./context.js";
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

/**
 * Ensure the macrodata daemon is running
 * Checks PID file, starts daemon if not running
 */
function ensureDaemonRunning(): void {
  const pidFile = join(homedir(), ".config", "macrodata", ".daemon.pid");
  const stateRoot = getStateRoot();
  const daemonScript = join(import.meta.dirname, "..", "bin", "macrodata-daemon.ts");
  
  // Check if daemon is already running
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (isProcessRunning(pid)) {
        return; // Daemon is running
      }
    } catch {
      // Invalid PID file, continue to start daemon
    }
  }
  
  // Start daemon - it writes its own PID file
  try {
    // Ensure config dir exists for PID file
    mkdirSync(join(homedir(), ".config", "macrodata"), { recursive: true });
    
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

// Track which sessions have had initial context injected
const injectedSessions = new Set<string>();

export const MacrodataPlugin: Plugin = async (_ctx: PluginInput) => {
  // Initialize state directories
  initializeStateRoot();

  // Ensure daemon is running for scheduled reminders
  ensureDaemonRunning();

  // Signal daemon to reload config (in case it was started with old config)
  signalDaemonReload();

  // Install skills to global config on plugin load
  installSkills();

  return {
    // Inject context on first message or when state files change
    "chat.message": async (input, output) => {
      const isFirstMessage = !injectedSessions.has(input.sessionID);
      const filesChanged = !isFirstMessage && checkFilesChanged(input.sessionID);

      if (isFirstMessage || filesChanged) {
        if (isFirstMessage) {
          injectedSessions.add(input.sessionID);
        }

        try {
          const memoryContext = await formatContextForPrompt();

          if (memoryContext) {
            const contextPart: Part = {
              id: `macrodata-context-${Date.now()}`,
              sessionID: input.sessionID,
              messageID: output.message.id,
              type: "text",
              text: memoryContext,
              synthetic: true,
            };

            // Prepend context to message parts
            output.parts.unshift(contextPart);

            // Store lastmod after successful injection
            storeLastmod(input.sessionID);
          }
        } catch (err) {
          logger.error(`Context injection error: ${String(err)}`);
        }
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
