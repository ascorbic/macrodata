const DEFAULT_AGENT_NAME = "default";
const WILDCARD_AGENT_NAME = "*";

const sessionAgentMap = new Map<string, string>();

export function setSessionAgent(sessionID: string, agent: string | undefined): void {
  sessionAgentMap.set(sessionID, agent ?? DEFAULT_AGENT_NAME);
}

export function hasSessionAgent(sessionID: string): boolean {
  return sessionAgentMap.has(sessionID);
}

export function getSessionAgent(sessionID: string): string | undefined {
  return sessionAgentMap.get(sessionID);
}

export function clearSession(sessionID: string): void {
  sessionAgentMap.delete(sessionID);
}

export function isAgentEnabled(agent: string | undefined, enabledAgents: string[]): boolean {
  if (enabledAgents.includes(WILDCARD_AGENT_NAME)) {
    return true;
  }

  if (agent === undefined) {
    return false;
  }

  return enabledAgents.includes(agent);
}
