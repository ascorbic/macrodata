/**
 * Regression tests for the OpenCode conversation indexer SQL (#25).
 *
 * queryExchanges interpolates a time filter inside the user_messages CTE,
 * where only the `m` (message) alias is in scope. A previous version used
 * `um.time_created`, which threw `no such column` on every incremental
 * re-index and silently disabled indexing.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { queryExchanges } from "../opencode/conversations";

function createOpenCodeDb(): Database {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT)`);
  db.run(`CREATE TABLE session (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    parent_id TEXT,
    directory TEXT,
    time_created INTEGER
  )`);
  db.run(`CREATE TABLE message (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    time_created INTEGER,
    data TEXT
  )`);
  db.run(`CREATE TABLE part (
    id TEXT PRIMARY KEY,
    message_id TEXT,
    session_id TEXT,
    time_created INTEGER,
    data TEXT
  )`);
  return db;
}

function seedExchange(
  db: Database,
  opts: { sessionId: string; userMsgId: string; assistantMsgId: string; timeMs: number; userText: string }
) {
  db.run(`INSERT OR IGNORE INTO project (id, worktree) VALUES ('prj_1', '/tmp/proj')`);
  db.run(`INSERT OR IGNORE INTO session (id, project_id, parent_id, directory, time_created) VALUES (?, 'prj_1', NULL, '/tmp/proj', ?)`, [
    opts.sessionId,
    opts.timeMs,
  ]);
  db.run(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`, [
    opts.userMsgId,
    opts.sessionId,
    opts.timeMs,
    JSON.stringify({ role: "user" }),
  ]);
  db.run(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`, [
    opts.assistantMsgId,
    opts.sessionId,
    opts.timeMs + 1000,
    JSON.stringify({ role: "assistant" }),
  ]);
  db.run(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`, [
    `${opts.userMsgId}-p`,
    opts.userMsgId,
    opts.sessionId,
    opts.timeMs,
    JSON.stringify({ type: "text", text: opts.userText }),
  ]);
  db.run(`INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`, [
    `${opts.assistantMsgId}-p`,
    opts.assistantMsgId,
    opts.sessionId,
    opts.timeMs + 1000,
    JSON.stringify({ type: "text", text: "assistant reply" }),
  ]);
}

describe("queryExchanges", () => {
  let db: Database;

  beforeEach(() => {
    db = createOpenCodeDb();
  });

  afterEach(() => {
    db.close();
  });

  test("returns all exchanges without a time filter", () => {
    seedExchange(db, { sessionId: "ses_1", userMsgId: "msg_u1", assistantMsgId: "msg_a1", timeMs: 1000, userText: "hello" });
    seedExchange(db, { sessionId: "ses_1", userMsgId: "msg_u2", assistantMsgId: "msg_a2", timeMs: 5000, userText: "world" });

    const rows = queryExchanges(db);

    expect(rows).toHaveLength(2);
    expect(rows[0].user_text).toBe("hello");
    expect(rows[1].user_text).toBe("world");
  });

  test("incremental query with sinceMs does not throw and filters correctly (#25)", () => {
    seedExchange(db, { sessionId: "ses_1", userMsgId: "msg_u1", assistantMsgId: "msg_a1", timeMs: 1000, userText: "old" });
    seedExchange(db, { sessionId: "ses_1", userMsgId: "msg_u2", assistantMsgId: "msg_a2", timeMs: 5000, userText: "new" });

    const rows = queryExchanges(db, 2000);

    expect(rows).toHaveLength(1);
    expect(rows[0].user_text).toBe("new");
    expect(rows[0].user_msg_id).toBe("msg_u2");
  });

  test("throws on schema mismatch instead of returning an empty no-op result (#25)", () => {
    const broken = new Database(":memory:");
    broken.run(`CREATE TABLE message (id TEXT PRIMARY KEY)`);

    expect(() => queryExchanges(broken, 1000)).toThrow();

    broken.close();
  });

  test("excludes subtask sessions", () => {
    seedExchange(db, { sessionId: "ses_parent", userMsgId: "msg_u1", assistantMsgId: "msg_a1", timeMs: 1000, userText: "parent" });
    db.run(`INSERT INTO session (id, project_id, parent_id, directory, time_created) VALUES ('ses_child', 'prj_1', 'ses_parent', '/tmp/proj', 2000)`);
    db.run(`INSERT INTO message (id, session_id, time_created, data) VALUES ('msg_cu', 'ses_child', 2000, ?)`, [
      JSON.stringify({ role: "user" }),
    ]);

    const rows = queryExchanges(db);

    expect(rows).toHaveLength(1);
    expect(rows[0].user_text).toBe("parent");
  });
});
