#!/usr/bin/env bun
/**
 * Ambient-recall async worker (spike).
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
 * Protocol (all files live in this dir, keyed by session_id):
 *   hook  writes  .recall-request-<sid>.json  {sid, search, rerankQuery, ts}
 *   worker reads+deletes the request, reranks, writes
 *          .recall-inbox-<sid>.json  {ts, hits: SearchResult[]}
 *   hook  reads+deletes the inbox on its next fire and injects.
 * In-context exclude: the worker excludes chunks the hook says are already in
 * context by reading .recall-exclude-<sid>.json (the hook computes the window-scoped
 * delta∪frozen set each fire; the worker just consumes it).
 *
 * Run:  bun run worker.ts   (foreground; the supervisor will daemonize it later)
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, watch } from "fs";
import { join } from "path";
import { pipelineSearch } from "./fts.ts";

const DIR = import.meta.dir;
const FLOOR = Number(process.env.MACRODATA_RECALL_FLOOR ?? 0.5);
const LIMIT = Number(process.env.MACRODATA_RECALL_LIMIT ?? 3);
const REQ_RE = /^\.recall-request-(.+)\.json$/;

interface Request { sid: string; search: string; rerankQuery: string; ts?: string }

const reqPath = (sid: string) => join(DIR, `.recall-request-${sid}.json`);
const inboxPath = (sid: string) => join(DIR, `.recall-inbox-${sid}.json`);
// The hook computes the window-scoped, EXACT in-context exclude set (delta ∪ frozen,
// Porrima inContextIds) and writes it here each fire; the worker just consumes it for
// pool-stage (pre-rerank) exclusion so fresh hits backfill.
const excludePath = (sid: string) => join(DIR, `.recall-exclude-${sid}.json`);

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
  const t0 = Date.now();
  let hits: Awaited<ReturnType<typeof pipelineSearch>>;
  try {
    hits = await pipelineSearch(req.search, {
      limit: LIMIT, floor: FLOOR, rerankQuery: req.rerankQuery, exclude,
    });
  } catch (e) {
    console.error(`[worker] ${req.sid}: pipeline error: ${String(e)}`);
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
      console.log(`[worker] ${req.sid}: ${hits.length} hit(s) -> inbox (${ms}ms)`);
    } catch (e) {
      // Dropped result → under-recall (safe), but make it visible: an unwrapped throw
      // here (e.g. ENOSPC) would otherwise vanish as an unhandled rejection on void drain().
      console.warn(`[worker] ${req.sid}: inbox write failed, result dropped: ${String(e)}`);
    }
  } else {
    console.log(`[worker] ${req.sid}: 0 hits (${ms}ms)`);
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
  catch (e) { console.warn(`[worker] ${sid}: skipping malformed request file: ${String(e)}`); return; }
  try { unlinkSync(p); } catch {} // consume; latest-wins handled by the map
  if (!req.search || req.search.length < 8) return;
  pending.set(sid, req);
  void drain();
}

// Models load LAZILY on the first request (Caleb, 2026-07-21): no memory held
// until recall actually fires; the mailbox protocol already tolerates a late
// first hit. Do not add eager preload here.
// Initial sweep (pick up requests written before the worker started), then watch.
for (const f of readdirSync(DIR)) {
  const m = f.match(REQ_RE);
  if (m) ingest(m[1]);
}
watch(DIR, (_event, filename) => {
  if (!filename) return;
  const m = String(filename).match(REQ_RE);
  if (m) ingest(m[1]);
});
console.log(`[worker] watching ${DIR} for .recall-request-*.json (in-process models, floor ${FLOOR}, limit ${LIMIT})`);
