#!/usr/bin/env bun
/**
 * Ambient-recall async worker.
 *
 * Long-lived process that runs the SLOW pipeline off the hook's blocking path.
 * The hook drops a request file; this worker reranks and writes an inbox file;
 * the hook drains the inbox on its NEXT fire. That's 3fz's competitive
 * injection: a slow hit defers to the next opportunity instead of stalling the
 * current tool call.
 *
 * Why this shape (profiled 2026-06-17): rerank dominates at ~127ms/doc × ~40
 * candidates ≈ 5s; vector+fts+corpus ≈ 320ms. Moving the rerank off the tool
 * round-trip is the whole win. A long-lived worker also amortizes the
 * per-process FTS corpus build (~160ms) and owns the in-process models
 * (models.ts singletons) — the ONLY process that loads them; the hook never does.
 *
 * Protocol (all files live in the mailbox dir, keyed by session_id):
 *   hook  writes  request-<sid>.json  {sid, search, rerankQuery, ts}
 *   worker reads+deletes the request, reranks, writes
 *          inbox-<sid>.json  {ts, hits: SearchResult[]}
 *   hook  reads+deletes the inbox on its next fire and injects.
 * In-context exclude: the worker excludes chunks the hook says are already in
 * context by reading exclude-<sid>.json (the hook computes the window-scoped
 * delta∪frozen set each fire; the worker just consumes it).
 *
 * Run:  bun run src/recall/worker.ts   (foreground; bin/recall-supervisor.sh daemonizes it)
 *
 * The supervisor appends `--macrodata-recall-worker <state root>` to that
 * command line. Nothing here parses them — they exist so the supervisor can
 * identify its own workers in `ps` without matching a source path that changes
 * with every plugin version. Dropping them makes every worker unreapable.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, mkdirSync, watch } from "fs";
import { configure, getConsoleSink, getLogger, jsonLinesFormatter } from "@logtape/logtape";
import { envNum, pipelineSearch } from "./fts.ts";
import { getMailboxDir, getRequestPath, getInboxPath, getExcludePath } from "./config.ts";

// Created before the watch below: fs.watch throws on a missing directory, and on
// a fresh state root nothing has written the mailbox yet.
const DIR = getMailboxDir();
mkdirSync(DIR, { recursive: true });
const FLOOR = envNum("MACRODATA_RECALL_FLOOR", 0.5, 0);
const LIMIT = envNum("MACRODATA_RECALL_LIMIT", 3, 1);
const REQ_RE = /^request-(.+)\.json$/;
const SWEEP_DEBOUNCE_MS = 50;
const SWEEP_INTERVAL_MS = 5_000;
// The protocol is latest-wins, so a request this old belongs to a turn the agent
// has moved past (or a session that ended): serving it spends a ~5s rerank to
// write an inbox nobody will ever drain.
// envNum, not bare Number(): "" would parse to 0 (drop every request as stale)
// and a non-numeric value to NaN (guard silently off) — and hook.ts already
// parses this env family through envNum, so the two processes must agree.
const MAX_REQ_AGE_MS = envNum("MACRODATA_RECALL_MAX_REQ_AGE_MS", 10 * 60_000, 1);

// NDJSON to stdout (the supervisor redirects it to .worker.log), so the log is
// jq-able and every record carries its own timestamp — the log is the primary
// forensic record for liveness incidents, and protocol-file mtimes vanish as
// the worker consumes them. Level boundary: warning = degraded but proceeding
// (a request or result lost, worker healthy); error = operation abandoned.
await configure({
  sinks: { console: getConsoleSink({ formatter: jsonLinesFormatter }) },
  loggers: [
    { category: ["recall"], lowestLevel: "debug", sinks: ["console"] },
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
  ],
});
const workerLog = getLogger(["recall", "worker"]);   // process lifecycle
const ingestLog = getLogger(["recall", "ingest"]);   // mailbox protocol: watch, consume, queue
const pipelineLog = getLogger(["recall", "pipeline"]); // the rerank run itself

interface Request { sid: string; search: string; rerankQuery: string; ts?: string }

const reqPath = getRequestPath;
const inboxPath = getInboxPath;
// The hook computes the window-scoped, EXACT in-context exclude set (delta ∪ frozen,
// Porrima inContextIds) and writes it here each fire; the worker just consumes it for
// pool-stage (pre-rerank) exclusion so fresh hits backfill.
const excludePath = getExcludePath;

function loadExclude(sid: string): Set<string> {
  const p = excludePath(sid);
  if (!existsSync(p)) return new Set();
  try { return new Set(JSON.parse(readFileSync(p, "utf-8")) as string[]); } catch { return new Set(); }
}

function atomicWrite(path: string, data: string): void {
  // pid-unique tmp so a hook process writing the same path can't interleave
  // with this writer's tmp file before the atomic rename (see hook.ts twin).
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

// latest-request-wins per session; coalesce bursts so we never rerank a query
// the agent has already moved past.
const pending = new Map<string, Request>();
let running = false;

async function runPipeline(req: Request): Promise<void> {
  const exclude = loadExclude(req.sid);
  const l = pipelineLog.with({ sid: req.sid });
  const t0 = Date.now();
  // Start line pairs with the completion/error line below: a pipeline whose
  // await never settles is then PROVABLE from the log (a start with no
  // matching end), not merely inferable from a consumed request that
  // produced nothing.
  l.info("pipeline start", { searchChars: req.search.length, excludeSize: exclude.size });
  let hits: Awaited<ReturnType<typeof pipelineSearch>>;
  try {
    hits = await pipelineSearch(req.search, {
      limit: LIMIT, floor: FLOOR, rerankQuery: req.rerankQuery, exclude,
    });
  } catch (e) {
    l.error("pipeline error", { error: String(e) });
    return;
  }
  const ms = Date.now() - t0;
  if (hits.length > 0) {
    // Stamp timing so the hook can render the span: requestedAt (when the hook
    // enqueued) → servedAt (now); pipelineMs is the off-path cost the tool call
    // never paid.
    try {
      atomicWrite(inboxPath(req.sid), JSON.stringify({
        requestedAt: req.ts ?? null,
        servedAt: new Date().toISOString(),
        pipelineMs: ms,
        // Echo the query that PRODUCED these hits. Async injection lags ~1 fire,
        // so the draining hook's own query is NOT this result's query — without
        // this the calibration log pairs each row's hits with the wrong (later)
        // query, poisoning any retrieval-quality read of the log.
        servedSearch: req.search,
        servedRerankQuery: req.rerankQuery,
        hits,
      }));
      l.info("hits -> inbox", { hits: hits.length, ms });
    } catch (e) {
      // Dropped result → under-recall (safe), but make it visible: an unwrapped throw
      // here (e.g. ENOSPC) would otherwise vanish as an unhandled rejection on void drain().
      l.warn("inbox write failed, result dropped", { error: String(e) });
    }
  } else {
    l.info("no hits", { hits: 0, ms });
  }
}

async function drain(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.size > 0) {
      const batch = [...pending.values()];
      pending.clear();
      for (const req of batch) await runPipeline(req);
    }
  } finally {
    running = false;
  }
}

function ingest(sid: string): void {
  const p = reqPath(sid);
  if (!existsSync(p)) return;
  let req: Request;
  try { req = { ...JSON.parse(readFileSync(p, "utf-8")), sid }; }
  catch (e) { ingestLog.warn("skipping malformed request file", { sid, error: String(e) }); return; }
  try { unlinkSync(p); } catch {} // consume; latest-wins handled by the map
  if (!req.search || req.search.length < 8) {
    // The request file is already consumed at this point — dropping without a
    // line means a schema-mismatched writer sees its requests vanish.
    ingestLog.warn("request dropped: search missing or under 8 chars", { sid, searchChars: req.search?.length ?? 0 });
    return;
  }
  const ageMs = req.ts ? Date.now() - Date.parse(req.ts) : 0;
  if (ageMs > MAX_REQ_AGE_MS) {
    // Consumed above, so a stale request costs one line and never re-enters the
    // sweep — info, not warning: dropping it is the correct outcome.
    ingestLog.info("request dropped: stale", { sid, ageMs });
    return;
  }
  pending.set(sid, req);
  // A queued request that never reaches its start line is the drain-wedge
  // signature (an earlier pipeline's await never settled, so `running` never
  // cleared) — this line makes that state visible in real time.
  if (running) ingestLog.info("queued behind active drain", { sid, pending: pending.size });
  void drain();
}

// Models load LAZILY on the first request (Caleb, 2026-07-21): no memory held
// until recall actually fires; the mailbox protocol already tolerates a late
// first hit. Do not add eager preload here.
// Initial sweep (pick up requests written before the worker started), then watch.
function sweep(): void {
  // A transient readdir failure (EMFILE under fd pressure, EACCES, ENOENT) must
  // degrade to one missed sweep — unguarded it would throw inside a timer
  // callback and kill the worker, which nothing restarts until the next
  // SessionStart. The interval retries in 5s anyway.
  let files: string[];
  try { files = readdirSync(DIR); }
  catch (e) { ingestLog.warn("sweep skipped: readdir failed", { error: String(e) }); return; }
  for (const f of files) {
    const m = f.match(REQ_RE);
    if (m) ingest(m[1]);
  }
}
sweep();
// Sweep on ANY event in the dir and ignore the reported filename. The hook
// publishes atomically (write `<path>.<pid>.tmp`, rename into place), and Bun
// 1.3.14's fs.watch on macOS reports only the tmp name for that pair — the final
// name is never delivered, so a filename matched against REQ_RE never fires for a
// real request. Measured 2026-08-13: fresh and 250-entry dirs, same- and
// cross-process writers, fresh and overwritten targets, 0/6 final-name events;
// the tmp write is the only reliable signal that a request arrived.
let pendingSweep: ReturnType<typeof setTimeout> | null = null;
watch(DIR, () => {
  if (pendingSweep) return;
  pendingSweep = setTimeout(() => { pendingSweep = null; sweep(); }, SWEEP_DEBOUNCE_MS);
});
// Load-bearing, not just a backstop: the debounce drops events during its 50ms
// window with no trailing re-arm, and whether a rename landing AFTER the
// debounced sweep delivers any event of its own is Bun-version-dependent
// (unmeasured on 1.3.14). This interval is the guarantee a request is ever
// read; the watch path is only a latency optimization. Don't remove or widen
// it without re-measuring the rename-event behavior.
setInterval(sweep, SWEEP_INTERVAL_MS);
workerLog.info("watching for recall requests", { dir: DIR, floor: FLOOR, limit: LIMIT });
