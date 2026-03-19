import { describe, test, expect } from "bun:test";
import {
  clearSession,
  getSessionAgent,
  hasSessionAgent,
  inferSessionAgent,
  isAgentEnabled,
  resolveSessionAgent,
  setSessionAgent,
} from "../opencode/session";

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

  test("does not allow unknown session agent when allowlist is explicit", () => {
    expect(isAgentEnabled(undefined, ["default", "build", "plan"])).toBe(false);
  });

  test("infers session agent when only one allowlisted agent exists", () => {
    expect(inferSessionAgent(["zeus"])).toBe("zeus");
  });

  test("does not infer session agent when multiple allowlisted agents exist", () => {
    expect(inferSessionAgent(["default", "build", "plan"])).toBeUndefined();
  });

  test("does not infer session agent when wildcard is used", () => {
    expect(inferSessionAgent(["*"])).toBeUndefined();
  });

  test("resolves and stores explicit agent from payload", () => {
    const sessionID = "session-resolve-explicit";
    clearSession(sessionID);

    const resolved = resolveSessionAgent({ sessionID, agent: "zeus" }, ["zeus"]);

    expect(resolved).toBe("zeus");
    expect(getSessionAgent(sessionID)).toBe("zeus");

    clearSession(sessionID);
  });

  test("keeps existing session agent even if later payload has a different agent", () => {
    const sessionID = "session-resolve-sticky";
    clearSession(sessionID);

    setSessionAgent(sessionID, "zeus");
    const resolved = resolveSessionAgent({ sessionID, agent: "build" }, ["zeus", "build"]);

    expect(resolved).toBe("zeus");
    expect(getSessionAgent(sessionID)).toBe("zeus");

    clearSession(sessionID);
  });

  test("infers and stores allowlisted agent when payload agent is missing", () => {
    const sessionID = "session-resolve-inferred";
    clearSession(sessionID);

    const resolved = resolveSessionAgent({ sessionID }, ["zeus"]);

    expect(resolved).toBe("zeus");
    expect(getSessionAgent(sessionID)).toBe("zeus");

    clearSession(sessionID);
  });

  test("does not resolve agent when payload is missing and allowlist is ambiguous", () => {
    const sessionID = "session-resolve-ambiguous";
    clearSession(sessionID);

    const resolved = resolveSessionAgent({ sessionID }, ["default", "build", "plan"]);

    expect(resolved).toBeUndefined();
    expect(hasSessionAgent(sessionID)).toBe(false);
  });

  test("supports default and wildcard matching", () => {
    expect(isAgentEnabled("default", ["default", "build", "plan"])).toBe(true);
    expect(isAgentEnabled("oracle", ["default", "build", "plan"])).toBe(false);
    expect(isAgentEnabled("oracle", ["*"])).toBe(true);
  });
});
