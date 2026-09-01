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
 * Run:  bun run src/recall/worker.ts   (foreground; bin/macrodata-hook.sh daemonizes it)
 *
 * The hook appends `--macrodata-recall-worker <state root>` to that command
 * line. Nothing here parses them — not even the root, which this process
 * resolves through getStateRoot() like every other entry point. They exist so
 * the hook can identify its own workers in `ps` without matching a source path
 * that changes with every plugin version. Dropping them makes every worker
 * unreapable.
 *
 * Exactly one worker serves a state root: the first thing this process does is
 * claim <root>/.recall/worker.pid, and a process that loses the claim exits
 * before it can load a model.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, readdirSync, mkdirSync, statSync, watch } from "fs";
import { join } from "path";
import { configure, getConsoleSink, getLogger, jsonLinesFormatter } from "@logtape/logtape";
import { envNum, pipelineSearch } from "./fts.ts";
import { TIMER_MAX_MS, WEDGED, withDeadline } from "./deadline.ts";
import { getMailboxDir, getRequestPath, getInboxPath, getExcludePath, getWorkerPidPath, getSpawnStampPath } from "./config.ts";
import { modelsLoaded } from "./models.ts";

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
const MAX_REQ_AGE_MS = envNum("MACRODATA_RECALL_MAX_REQ_AGE_MS", 10 * 60_000, 1, TIMER_MAX_MS);
// A pipeline whose await never settles is worse than a dead worker: `running`
// never clears, so every later request is queued and dropped, while this process
// stays in `ps` holding the claim — the hook reads it as healthy and
// claimWorkerSlot() makes any replacement stand down. Nothing outside this
// process can observe that state, so nothing outside it can end it.
//
// Two budgets, because the first run is a different job from the rest. It may
// download ~1.2GB of GGUFs (models.ts resolves `hf:` URIs on first use), while a
// warm rerank is ~5s. A single budget generous enough for that download leaves a
// real wedge undetected for as long as it takes; one tight enough to catch a
// wedge turns a slow first download into a restart loop that never finishes it.
const WEDGE_COLD_MS = envNum("MACRODATA_RECALL_WEDGE_COLD_MS", 20 * 60_000, 1_000, TIMER_MAX_MS);
const WEDGE_WARM_MS = envNum("MACRODATA_RECALL_WEDGE_WARM_MS", 2 * 60_000, 1_000, TIMER_MAX_MS);
// Files the protocol leaves behind rather than consumes: an inbox nobody drained,
// the two per-session baselines, and the scratch that a SIGKILL mid-write strands
// (`.tmp` from atomicWrite, `.claim` from the hook's inbox drain, `.bad` from a
// quarantine, `.trim` from the hook's log rotation). The TTL is generous because the baselines are rewritten only on a
// fire that gets far enough to have something to record — an early bail rewrites
// neither — so a live session's mtime can lag its last message by a long way, and
// culling one costs it the dedupe state that keeps recall from repeating itself.
const ORPHAN_TTL_MS = envNum("MACRODATA_RECALL_ORPHAN_TTL_MS", 7 * 24 * 60 * 60_000, 60_000, TIMER_MAX_MS);
const ORPHAN_SWEEP_MS = 60 * 60_000;
const ORPHAN_RE = /^(?:inbox|exclude|injected)-.+\.json$|\.(?:tmp|claim|bad|trim)$/;

// NDJSON to stdout (the hook redirects it to .recall/worker.log), so the log is
// jq-able line by line and every record carries its own timestamp. Only what
// goes through logtape is NDJSON — a crash trace or a library's console.warn
// reaches the same file through the shell redirection, so a reader must tolerate
// non-JSON lines rather than assume the file parses whole — the log is the primary
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

const errnoOf = (e: unknown): string =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";

// EPERM means the process exists and belongs to someone else — alive, and the
// one answer a mutex must never round down to "gone", since that steals a claim
// from a process still holding it.
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch (e) { return errnoOf(e) === "EPERM"; }
};

/**
 * Take the single-worker slot for this state root, or exit having loaded nothing.
 *
 * macrodata-hook.sh converges the worker on every prompt, so several sessions
 * that observe the same worker-less root spawn one each — right after an upgrade
 * reap, or on a first-ever start. Unclaimed, they all live, all drain the one
 * mailbox, and each loads its own embed and rerank models. Exclusive create
 * settles the burst on one survivor however tightly the spawns interleave, which
 * is what the check-then-write in the daemon's start() cannot promise.
 *
 * A dead holder is taken over rather than respected: the hook reaps a
 * previous-version worker with SIGKILL, which leaves no chance to clean up, so a
 * pidfile outliving its process is the normal case and not a fault.
 */
function claimWorkerSlot(): void {
  const pidPath = getWorkerPidPath();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(pidPath, `${process.pid}\n`, { flag: "wx" });
      return;
    } catch (e) {
      // Only EEXIST means "someone else got here first". A permission or space
      // failure reaching the contention path below would end at the warn at the
      // bottom, and every session on this machine would then start a worker of
      // its own — the mutex silently gone at exactly the moment the state root
      // is already unwell.
      if (errnoOf(e) !== "EEXIST") {
        workerLog.error("cannot write the worker slot, exiting", { pidPath, err: errnoOf(e) });
        process.exit(1);
      }
      let raw: string;
      // Gone between the failed create and this read — another loser cleared a
      // stale claim, so retry into the race it just opened.
      try { raw = readFileSync(pidPath, "utf-8").trim(); } catch { continue; }
      const holder = Number(raw);
      if (holder && holder !== process.pid && alive(holder)) {
        workerLog.info("another worker already serves this root, exiting", { holder, pidPath });
        process.exit(0);
      }
      // Delete only the claim just read, not whatever is there now. Two losers
      // reading the same dead holder is the ordinary post-upgrade case, and an
      // unconditional unlink lets the second one remove the fresh claim the
      // first just won — leaving both running on one mailbox. Re-reading is not
      // a compare-and-swap (POSIX offers none for unlink) and the window
      // survives; it is narrowed from "the whole takeover" to two adjacent
      // syscalls.
      try {
        if (readFileSync(pidPath, "utf-8").trim() === raw) unlinkSync(pidPath);
      } catch { /* a peer cleared the same stale claim */ }
    }
  }
  // Three collisions without a live holder means something is churning the file
  // that isn't a worker taking the slot. Serving recall beats holding the mutex.
  workerLog.warn("could not claim the worker slot, starting anyway", { pidPath });
}
claimWorkerSlot();
// Past this line a worker serves this root, so every start the hook recorded
// while none did is answered. Clearing here rather than at first request is what
// makes the hook's count mean "starts that left no worker": a worker that comes
// up healthy and then sits idle all day is not a failing install, and a count
// that never resets reports one on the next restart.
try { unlinkSync(getSpawnStampPath()); } catch { /* no failed starts recorded */ }
// Only ever removes OUR claim — the content check is what keeps the losing half
// of a spawn burst from deleting the winner's pidfile on its way out.
process.on("exit", () => {
  try {
    const p = getWorkerPidPath();
    if (readFileSync(p, "utf-8").trim() === String(process.pid)) unlinkSync(p);
  } catch { /* already gone, or already someone else's */ }
});
// Without these, a SIGTERM'd worker skips the exit handler and leaves a pidfile
// its successor has to clear. SIGKILL still can't be caught; the takeover above
// is what covers it.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

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
  // Ask the models whether they are loaded rather than inferring it from past
  // results: a run that returns nothing may never have reached the reranker
  // (rerank() returns early on an empty candidate pool), and a load that is
  // still downloading has produced no results at all. Both look identical from
  // here, and both would put the run that actually pays for the download on the
  // two-minute budget.
  const warm = modelsLoaded();
  const budget = warm ? WEDGE_WARM_MS : WEDGE_COLD_MS;
  let hits: Awaited<ReturnType<typeof pipelineSearch>> | typeof WEDGED;
  try {
    hits = await withDeadline(pipelineSearch(req.search, {
      limit: LIMIT, floor: FLOOR, rerankQuery: req.rerankQuery, exclude,
    }), budget);
  } catch (e) {
    l.error("pipeline error", { error: String(e) });
    return;
  }
  if (hits === WEDGED) {
    // Exit rather than skip this request. models.ts memoizes the pending load
    // promise and only drops it on rejection, so a load that never settles is
    // handed to every later request too — staying alive means every future
    // request wedges behind the same promise, and this process would keep the
    // claim that stops the hook from replacing it. Dying is what lets the next
    // convergence pass spawn a worker that can serve.
    l.error("pipeline exceeded its budget, exiting so the hook can restart it", {
      budgetMs: budget, warm, ms: Date.now() - t0,
    });
    process.exit(1);
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

// Distinguishes quarantines within the same millisecond; see the rename below.
let quarantineSeq = 0;

function ingest(sid: string): void {
  const p = reqPath(sid);
  if (!existsSync(p)) return;
  let req: Request;
  try { req = { ...JSON.parse(readFileSync(p, "utf-8")), sid }; }
  catch (e) {
    // Moved aside, not left in place. Nothing else consumes a request file, so
    // one that cannot be parsed is found again by every 5s sweep for the life of
    // the worker — a warn line every five seconds for as long as it sits there.
    //
    // The destination is unique per quarantine because the interesting case is
    // the repeating one: a writer emitting malformed requests emits several, and
    // a fixed name keeps only the last, discarding the evidence that it was a
    // pattern rather than one bad write. The orphan sweep expires them.
    const dest = `${p}.${Date.now()}-${quarantineSeq++}.bad`;
    ingestLog.warn("quarantining malformed request file", { sid, dest, error: String(e) });
    try { renameSync(p, dest); } catch { try { unlinkSync(p); } catch { /* already gone */ } }
    return;
  }
  try { unlinkSync(p); } catch {} // consume; latest-wins handled by the map
  // Typed, not merely truthy: a number is truthy and has no `.length`, so
  // `req.search.length < 8` is `undefined < 8` — false — and a JSON number sails
  // through into pipelineSearch(), which then calls string methods on it deep in
  // the FTS leg. The request file is already consumed at this point, so dropping
  // without a line means a schema-mismatched writer sees its requests vanish.
  if (typeof req.search !== "string" || req.search.length < 8) {
    ingestLog.warn("request dropped: search is not a string of at least 8 chars", {
      sid, searchType: typeof req.search, searchChars: typeof req.search === "string" ? req.search.length : null,
    });
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
  // callback and kill the worker. The interval retries in 5s anyway, which is
  // sooner than the hook's next convergence pass would notice the process gone.
  let files: string[];
  try { files = readdirSync(DIR); }
  catch (e) { ingestLog.warn("sweep skipped: readdir failed", { error: String(e) }); return; }
  for (const f of files) {
    const m = f.match(REQ_RE);
    if (m) ingest(m[1]);
  }
}
sweep();

/**
 * Delete mailbox files belonging to sessions that have ended.
 *
 * Only `request-` files are consumed by the protocol. Everything else is left
 * where it lands: an inbox the hook never drained (the session ended between the
 * rerank and the next fire), the two per-session baselines, and the scratch a
 * SIGKILL stranded mid-write. One session is a handful of files, so nothing here
 * is ever noticed — and nothing here is ever cleaned up either, so the mailbox
 * grows for the life of the state root and the 5s sweep's readdir pays for all of
 * it.
 *
 * Deliberately not in that sweep: this stats every entry, and the hot path runs
 * 720× an hour.
 *
 * The TTL is what makes an unsynchronized delete safe against a session the
 * worker cannot see, and it is set long because mtime is a floor on a session's
 * age, not a measure of it: the baselines are rewritten only by a fire with
 * something to record, so a session that has gone a week without one still holds
 * files this will not touch. Culling a live session's baselines is survivable
 * either way — it re-shows chunks that session has already been given, rather
 * than losing anything.
 */
function sweepOrphans(): void {
  let files: string[];
  try { files = readdirSync(DIR); }
  catch (e) { ingestLog.warn("orphan sweep skipped: readdir failed", { error: String(e) }); return; }
  const cutoff = Date.now() - ORPHAN_TTL_MS;
  let removed = 0;
  for (const f of files) {
    if (!ORPHAN_RE.test(f)) continue;
    const p = join(DIR, f);
    try {
      if (statSync(p).mtimeMs >= cutoff) continue;
      unlinkSync(p);
      removed++;
    } catch { /* raced with a hook writing or draining the same file */ }
  }
  if (removed > 0) ingestLog.info("swept orphaned mailbox files", { removed, ttlMs: ORPHAN_TTL_MS });
}
sweepOrphans();
setInterval(sweepOrphans, ORPHAN_SWEEP_MS);

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
