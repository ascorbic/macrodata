#!/usr/bin/env bun
/**
 * Macrodata Daemon
 *
 * Maintains a WebSocket connection to macrodata and writes state events
 * to ~/.claude/pending-context for injection via hooks.
 *
 * Usage:
 *   bun run ~/.claude/bin/macrodata-daemon.ts
 *
 * The daemon:
 * 1. Reads OAuth token from macOS keychain
 * 2. Validates token expiry
 * 3. Connects to macrodata WebSocket
 * 4. Writes events to pending-context file
 * 5. Reconnects on disconnect with backoff
 */

import { execSync } from "child_process";
import { appendFileSync, writeFileSync, existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Configuration
const KEYCHAIN_SERVICE = "Claude Code-credentials";
const MACRODATA_SERVER = "macrodata";
const PENDING_CONTEXT_PATH = join(homedir(), ".claude", "pending-context");
const STATIC_CONTEXT_PATH = join(homedir(), ".claude", "macrodata-context.md");
const CONFIG_PATH = join(homedir(), ".claude", "macrodata.json");
const PIDFILE_PATH = join(homedir(), ".claude", "macrodata-daemon.pid");
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const PING_INTERVAL = 30000;

interface MacrodataConfig {
  identity?: string; // Named identity to use from knowledge
}

interface McpOAuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  serverUrl: string;
  serverName: string;
}

interface KeychainCredentials {
  claudeAiOauth?: unknown;
  mcpOAuth?: Record<string, McpOAuthToken>;
}

interface StateEvent {
  type: "state_changed";
  source: "core" | "knowledge" | "journal" | "schedule";
  action: "created" | "updated" | "deleted";
  key: string;
  summary?: string;
  timestamp: string;
}

function log(message: string) {
  const ts = new Date().toISOString();
  console.error(`[${ts}] ${message}`);
}

function getConfig(): MacrodataConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const content = readFileSync(CONFIG_PATH, "utf-8");
      return JSON.parse(content);
    }
  } catch (err) {
    log(`Failed to read config: ${err}`);
  }
  return {};
}

function writePendingContext(message: string) {
  try {
    appendFileSync(PENDING_CONTEXT_PATH, message + "\n");
  } catch (err) {
    log(`Failed to write pending context: ${err}`);
  }
}

function getKeychainCredentials(): KeychainCredentials | null {
  try {
    const result = execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
    );
    return JSON.parse(result.trim());
  } catch (err) {
    log(`Failed to read keychain: ${err}`);
    return null;
  }
}

function getMacrodataToken(credentials: KeychainCredentials): McpOAuthToken | null {
  if (!credentials.mcpOAuth) return null;

  // Find the macrodata token (key format: "macrodata|hash")
  for (const [key, token] of Object.entries(credentials.mcpOAuth)) {
    if (key.startsWith(`${MACRODATA_SERVER}|`) || token.serverName === MACRODATA_SERVER) {
      return token;
    }
  }
  return null;
}

function isTokenExpired(token: McpOAuthToken): boolean {
  if (!token.expiresAt) return false;
  // Consider expired if within 5 minutes of expiry
  return Date.now() > token.expiresAt - 5 * 60 * 1000;
}

function formatEvent(event: StateEvent): string {
  const sourceEmoji: Record<string, string> = {
    core: "🔧",
    knowledge: "📚",
    journal: "📝",
    schedule: "⏰",
  };
  const actionVerb: Record<string, string> = {
    created: "added",
    updated: "updated",
    deleted: "deleted",
  };

  const emoji = sourceEmoji[event.source] || "📌";
  const verb = actionVerb[event.action] || event.action;
  const summary = event.summary ? `: ${event.summary}` : "";

  return `[macrodata] ${emoji} ${event.source}/${event.key} ${verb}${summary}`;
}

class MacrodataDaemon {
  private ws: WebSocket | null = null;
  private token: McpOAuthToken | null = null;
  private reconnectDelay = RECONNECT_BASE_DELAY;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private shouldRun = true;

  async start() {
    log("Starting macrodata daemon");

    // Write PID file
    writeFileSync(PIDFILE_PATH, process.pid.toString());

    // Set up signal handlers
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());

    // Initial connection attempt
    await this.connect();
  }

  private async connect() {
    if (!this.shouldRun) return;

    // Get credentials from keychain
    const credentials = getKeychainCredentials();
    if (!credentials) {
      writePendingContext(
        "[macrodata] ⚠️ Not configured - credentials not found in keychain. User should authenticate via /mcp."
      );
      log("No credentials found, exiting");
      this.shutdown();
      return;
    }

    // Get macrodata token
    this.token = getMacrodataToken(credentials);
    if (!this.token) {
      writePendingContext(
        "[macrodata] ⚠️ Not configured - macrodata MCP not found. User should add it via /mcp."
      );
      log("No macrodata token found, exiting");
      this.shutdown();
      return;
    }

    // Check token expiry
    if (isTokenExpired(this.token)) {
      writePendingContext(
        "[macrodata] ⚠️ Token expired - call get_context to refresh authentication."
      );
      log("Token expired, exiting");
      this.shutdown();
      return;
    }

    // Build WebSocket URL
    const serverUrl = new URL(this.token.serverUrl);
    const wsUrl = `wss://${serverUrl.host}/ws`;

    log(`Connecting to ${wsUrl}`);

    try {
      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.token.accessToken}`,
        },
      } as any);

      this.ws.onopen = async () => {
        log("Connected");
        this.reconnectDelay = RECONNECT_BASE_DELAY;
        this.startPing();
        await this.fetchAndWriteContext();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data as string);
      };

      this.ws.onclose = (event) => {
        log(`Disconnected (code: ${event.code})`);
        this.stopPing();
        this.scheduleReconnect();
      };

      this.ws.onerror = (error) => {
        log(`WebSocket error: ${error}`);
      };
    } catch (err) {
      log(`Connection failed: ${err}`);
      this.scheduleReconnect();
    }
  }

  private async fetchAndWriteContext() {
    if (!this.token) return;

    try {
      const serverUrl = new URL(this.token.serverUrl);
      const config = getConfig();
      const contextUrl = new URL(`https://${serverUrl.host}/context`);
      if (config.identity) {
        contextUrl.searchParams.set("identity", config.identity);
      }

      log(`Fetching context from ${contextUrl}`);

      const response = await fetch(contextUrl, {
        headers: {
          Authorization: `Bearer ${this.token.accessToken}`,
        },
      });

      if (!response.ok) {
        log(`Failed to fetch context: ${response.status}`);
        return;
      }

      const context = await response.text();
      writeFileSync(STATIC_CONTEXT_PATH, context);
      log(`Wrote context to ${STATIC_CONTEXT_PATH}`);
    } catch (err) {
      log(`Error fetching context: ${err}`);
    }
  }

  private handleMessage(data: string) {
    try {
      const event = JSON.parse(data) as StateEvent | { type: string };

      if (event.type === "pong") {
        // Ping response, ignore
        return;
      }

      if (event.type === "state_changed") {
        const stateEvent = event as StateEvent;
        const formatted = formatEvent(stateEvent);
        log(`Event: ${formatted}`);
        writePendingContext(formatted);
      }
    } catch (err) {
      log(`Failed to parse message: ${err}`);
    }
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "ping" }));
      }
    }, PING_INTERVAL);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (!this.shouldRun) return;

    log(`Reconnecting in ${this.reconnectDelay}ms`);
    setTimeout(() => this.connect(), this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_DELAY);
  }

  private shutdown() {
    log("Shutting down");
    this.shouldRun = false;
    this.stopPing();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Clean up PID file
    try {
      if (existsSync(PIDFILE_PATH)) {
        const pid = readFileSync(PIDFILE_PATH, "utf-8").trim();
        if (pid === process.pid.toString()) {
          require("fs").unlinkSync(PIDFILE_PATH);
        }
      }
    } catch {
      // Ignore cleanup errors
    }

    process.exit(0);
  }
}

// Main
const daemon = new MacrodataDaemon();
daemon.start().catch((err) => {
  log(`Fatal error: ${err}`);
  process.exit(1);
});
