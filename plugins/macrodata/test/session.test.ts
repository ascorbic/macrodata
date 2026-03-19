import { describe, test, expect } from "bun:test";
import { clearSession, getSessionAgent, hasSessionAgent, isAgentEnabled, setSessionAgent } from "../opencode/session";

describe("opencode/session", () => {
  test("tracks explicit agent name", () => {
    const sessionID = "session-explicit";
    clearSession(sessionID);

    setSessionAgent(sessionID, "build");

    expect(hasSessionAgent(sessionID)).toBe(true);
    expect(getSessionAgent(sessionID)).toBe("build");

    clearSession(sessionID);
  });

  test("normalizes undefined agent to default", () => {
    const sessionID = "session-default";
    clearSession(sessionID);

    setSessionAgent(sessionID, undefined);

    expect(hasSessionAgent(sessionID)).toBe(true);
    expect(getSessionAgent(sessionID)).toBe("default");

    clearSession(sessionID);
  });

  test("does not treat unknown session as default", () => {
    expect(isAgentEnabled(undefined, ["default", "build", "plan"])).toBe(false);
  });

  test("supports default and wildcard matching", () => {
    expect(isAgentEnabled("default", ["default", "build", "plan"])).toBe(true);
    expect(isAgentEnabled("oracle", ["default", "build", "plan"])).toBe(false);
    expect(isAgentEnabled("oracle", ["*"])).toBe(true);
  });
});
