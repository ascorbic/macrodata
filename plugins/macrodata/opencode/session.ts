const DEFAULT_AGENT_NAME = "default";
const WILDCARD_AGENT_NAME = "*";

interface SessionAgentPayload {
  sessionID?: string;
  agent?: unknown;
}

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

export function inferSessionAgent(enabledAgents: string[]): string | undefined {
  if (enabledAgents.length === 1 && !enabledAgents.includes(WILDCARD_AGENT_NAME)) {
    return enabledAgents[0];
  }

  return undefined;
}

export function resolveSessionAgent(
  payload: SessionAgentPayload,
  enabledAgents: string[]
): string | undefined {
  if (!payload.sessionID) {
    return undefined;
  }

  if (hasSessionAgent(payload.sessionID)) {
    return getSessionAgent(payload.sessionID);
  }

  if (typeof payload.agent === "string") {
    setSessionAgent(payload.sessionID, payload.agent);
    return payload.agent;
  }

  const inferredAgent = inferSessionAgent(enabledAgents);
  if (inferredAgent) {
    setSessionAgent(payload.sessionID, inferredAgent);
  }

  return inferredAgent;
}
