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
import { memoryTools } from "./tools.js";
import { formatContextForPrompt, getStateRoot, storeLastmod, checkFilesChanged } from "./context.js";
import { logJournal } from "./journal.js";

// Track which sessions have had initial context injected
const injectedSessions = new Set<string>();

export const MacrodataPlugin: Plugin = async (ctx: PluginInput) => {
  const { directory } = ctx;
  const stateRoot = getStateRoot();

  console.error(`[Macrodata] Plugin initialized for ${directory}`);
  console.error(`[Macrodata] State root: ${stateRoot}`);

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

            const reason = isFirstMessage ? "first message" : "state files changed";
            console.error(
              `[Macrodata] Injected context (${memoryContext.length} chars, ${reason})`
            );
          }
        } catch (err) {
          console.error(`[Macrodata] Context injection error: ${String(err)}`);
        }
      }
    },

    // Inject memory context before compaction
    "experimental.session.compacting": async (_input, output) => {
      try {
        const memoryContext = await formatContextForPrompt({ forCompaction: true });

        if (memoryContext) {
          output.context.push(memoryContext);
          console.error("[Macrodata] Injected context for compaction");
        }
      } catch (err) {
        console.error(`[Macrodata] Compaction hook error: ${String(err)}`);
      }
    },

    // Auto-journal git commands and file changes
    // Use tool.execute.before to capture args before execution
    "tool.execute.before": async (input, output) => {
      try {
        const args = output.args as Record<string, unknown>;

        // Log git commands
        if (input.tool === "bash") {
          const command = (args?.command as string) || "";

          // Only log significant git commands
          if (
            /^git (commit|push|pull|merge|rebase|checkout -b|branch -[dD])/.test(
              command
            )
          ) {
            await logJournal("git", `Command: ${command}`);
          }
        }

        // Log file changes (but not too verbosely)
        if (input.tool === "write" || input.tool === "edit") {
          const filePath = (args?.filePath as string) || (args?.file_path as string) || "";

          // Skip temp files, node_modules, etc.
          if (
            filePath &&
            !/node_modules|\.tmp|\.cache|__pycache__|\.git\//.test(filePath)
          ) {
            await logJournal("file-change", `${input.tool}: ${filePath}`);
          }
        }
      } catch (err) {
        // Don't let journaling errors break the flow
        console.error(`[Macrodata] Auto-journal error: ${String(err)}`);
      }
    },

    // Provide memory tools
    tool: memoryTools,
  };
};

// Default export for OpenCode plugin system
export default MacrodataPlugin;
