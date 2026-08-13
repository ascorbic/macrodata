#!/usr/bin/env bun
/**
 * Ambient-recall hook — fires on UserPromptSubmit, PostToolUse
 * (Read/WebSearch/WebFetch), and Stop.
 *
 * Reads a Claude Code hook envelope on stdin, builds a scrubbed query from the
 * current context, runs the retrieval pipeline (vector + FTS + RRF + recency +
 * in-process rerank + floor), and — only if something clears the floor — emits
 * an additionalContext block. Stays SILENT otherwise (the whole point: no
 * noise). EXPECTED errors (missing files, lost claim races, malformed inbox
 * hits) degrade silently; an UNEXPECTED error fails LOUDLY — visible stderr +
 * exit 1 — but never BLOCKS: exit 1 is Claude Code's non-blocking hook
 * failure (exit 2 would block the tool call; nothing here may exit 2).
 * Squeaky-gate policy (Caleb, 2026-07-23): a surprise bug should announce
 * itself per-fire until fixed, not silently disable recall.
 *
 * Modes (MACRODATA_RECALL_MODE): "async" (default) — mailbox protocol with
 * worker.ts; this process NEVER loads models. "sync" — run the pipeline inline,
 * which loads the GGUFs IN THIS per-fire process; debugging only. --query
 * always runs sync.
 *
 * Manual test:  echo '{"tool_name":"Read","tool_input":{"file_path":"x/porrima.md"}}' | MACRODATA_RECALL_MODE=sync bun run bin/recall-hook.ts
 *          or:  bun run bin/recall-hook.ts --query "what is porrima"
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { envNum, pipelineSearch } from "../src/recall/fts.ts";
import type { SearchResult } from "../src/recall/indexer.ts";
import { buildHookQuery, analyzeTranscript, scrubOperationalNoise } from "../src/recall/query.ts";
import { memKey, recordAccess } from "../src/recall/access.ts";
import {
  getCalibrationLog,
  getExcludePath,
  getInboxPath,
  getInjectedPath,
  getMailboxDir,
  getRequestPath,
} from "../src/recall/config.ts";

const FLOOR = envNum("MACRODATA_RECALL_FLOOR", 0.5, 0);
const LIMIT = envNum("MACRODATA_RECALL_LIMIT", 3, 1);
const MIN_QUERY_CHARS = 8;
// Sampled calibration: fraction of recall INJECTIONS that also ask the agent to
// journal a usefulness verdict. Rate-limited so it doesn't flood the turn with
// meta-tasks. 0 disables. This is the lossless human-judgment signal (distinct
// from the punted "was-it-referenced" inference) that feeds floor/recency tuning.
const VERDICT_RATE = envNum("MACRODATA_RECALL_VERDICT_RATE", 0.25, 0);

function emitSilent(): never {
  // No output = nothing injected.
  process.exit(0);
}

async function main(): Promise<void> {
  const t0 = Date.now();
  let env: {
    tool_name?: string;
    tool_input?: Record<string, unknown>;
    transcript_path?: string;
    hook_event_name?: string;
    prompt?: string;
    session_id?: string;
  } = {};
  const qIdx = process.argv.indexOf("--query");
  if (qIdx >= 0) {
    env = { tool_name: "Manual", tool_input: { query: process.argv[qIdx + 1] } };
  } else if (!process.stdin.isTTY) {
    const raw = await Bun.stdin.text();
    if (raw.trim()) {
      try { env = JSON.parse(raw); } catch { emitSilent(); }
    }
  }

  const event = env.hook_event_name ?? "PostToolUse";

  // Mode: async (default) keeps models strictly in the worker; sync is the
  // explicit debug override (inline pipeline = per-fire model load). The old
  // MACRODATA_RECALL_ASYNC=1 wiring is subsumed by the async default.
  const MODE = qIdx >= 0 || process.env.MACRODATA_RECALL_MODE === "sync" ? "sync" : "async";

  // ONE transcript read per fire — query build AND compaction window come out
  // of the same parse (this used to be two full read+parse passes, a real tax
  // on the blocking path late in a long session).
  const ta = env.transcript_path ? analyzeTranscript(env.transcript_path) : null;

  // Real query = the surrounding conversation (wide search / tight rerank).
  let search: string, rerankQuery: string;
  if (event === "UserPromptSubmit") {
    // Turn-start: the just-submitted prompt is the rerank focus (user just
    // spoke); blend recent transcript context into the wide search. The window
    // already includes the prior assistant turn, so no separate Stop pass.
    const prompt = scrubOperationalNoise(typeof env.prompt === "string" ? env.prompt : "");
    const tq = ta?.query ?? { search: "", rerank: "" };
    search = `${prompt}\n${tq.search}`.slice(0, 6000);
    // Blend fresh prompt + recent trajectory — bare prompt is too thin a rerank
    // signal (the naive-prompt-as-query trap, this time at the rerank stage).
    rerankQuery = `${prompt} ${tq.rerank}`.slice(0, 900);
  } else if (ta) {
    const q = ta.query;
    search = q.search;
    rerankQuery = q.rerank;
    // Stop is registered as a PRIME-ONLY pass (see the async branch below +
    // settings.local.json): it enqueues the turn's context for the worker but
    // never drains/injects. Gate it on a substantial turn so we don't prime on
    // a trivial "ok"-sized response.
    if (event === "Stop") {
      if (!(q.latest.thinking >= 150 || q.latest.text >= 300)) emitSilent();
    } else {
      // Tool path: fold in the current tool's intent (the just-issued action).
      const intent = buildHookQuery(env);
      if (intent) { search = `${intent}\n${search}`.slice(0, 6000); rerankQuery = `${intent} ${rerankQuery}`.slice(0, 900); }
    }
  } else {
    search = buildHookQuery(env);
    rerankQuery = search;
  }
  if (search.length < MIN_QUERY_CHARS) emitSilent();

  const sid = (env.session_id || "").replace(/[^A-Za-z0-9_-]/g, "");
  // Both dirs are created up front: every write below assumes they exist, and on
  // a fresh state root nothing else has made them yet.
  mkdirSync(getMailboxDir(), { recursive: true });
  const injectedFile = sid ? getInjectedPath(sid) : "";
  const excludeFile = sid ? getExcludePath(sid) : "";
  const atomicWrite = (path: string, data: string): void => {
    // pid-unique tmp: parallel tool calls fire concurrent same-sid hooks, and
    // a shared tmp path lets two writers interleave (write is not atomic
    // across processes) before one renames torn bytes into place. rename
    // itself is atomic; the tmp file must be private to this writer.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  };

  // ---- Unified in-context EXCLUDE (Porrima inContextIds = frozen ∪ delta) ----
  // EXACT, content-keyed, scoped to the live COMPACTION WINDOW, and excluded in the
  // candidate POOL (pre-rerank) so fresh hits backfill → inject MORE, never less.
  //   delta  = chunks this session's hook injected WITHIN the window (injected-<sid>,
  //            stored {c,ts} so it window-scopes; Porrima deltaIds, resets at compaction).
  //   frozen = journal entries I AUTHORED in the window (`[topic] content` log_journal
  //            keys, byte-identical to the indexed form; Porrima frozenIds).
  // EXACT match only — we suppress ONLY what we provably produced/injected; anything
  // uncertain is injected (Caleb's under-cull). Written to exclude-<sid> so the
  // worker (async path) excludes in its pool too. inContextWindow() handles the window.
  type Inj = { c: string; ts: string };
  const loadInjected = (): Inj[] => {
    if (!injectedFile || !existsSync(injectedFile)) return [];
    try {
      return (JSON.parse(readFileSync(injectedFile, "utf-8")) as unknown[])
        .map((e) => (typeof e === "string" ? { c: e, ts: "" } : (e as Inj))); // legacy string[] → ts-less
    } catch { return []; }
  };
  // Resolve the compaction window BEFORE persistInjected — that closure reads
  // windowStartTs, so it must be in scope first (no temporal-dead-zone trap).
  // Comes from the SAME transcript parse as the query build (analyzeTranscript).
  const { windowStartTs, authoredKeys } = ta ?? { windowStartTs: "", authoredKeys: new Set<string>() };
  const persistInjected = (chunks: SearchResult[]): void => {
    if (!injectedFile) return;
    try {
      const now = new Date().toISOString();
      // Prune pre-window + ts-less entries (ineligible) — PRIMARY growth bound. Lexical
      // ISO compare: both ts are canonical `…Z`+ms (toISOString), so lexical==chronological;
      // a format mismatch fails toward DROPPING (under-cull), never echo. cap(1000) is a
      // pathological backstop for a never-compacting mega-session — overshoot = harmless
      // echo (under-cull-safe). atomicWrite publishes whole files only; note a
      // concurrent fire's read-modify-write can still lose entries last-writer-
      // wins (under-cull-safe, tracked with the mailbox-robustness work).
      const kept = loadInjected().filter((e) => e.ts && (!windowStartTs || e.ts >= windowStartTs));
      for (const h of chunks) kept.push({ c: h.content, ts: now });
      atomicWrite(injectedFile, JSON.stringify(kept.slice(-1000)));
    } catch {}
  };
  const excludeSet = new Set<string>([
    // delta in-window: a ts-less (legacy) or pre-window injection is treated as NOT in
    // context (re-eligible) — conservative, under-cull. Lexical ISO compare (canonical
    // `…Z`+ms invariant; mismatch fails toward dropping = under-cull-safe).
    ...loadInjected().filter((e) => e.ts && (!windowStartTs || e.ts >= windowStartTs)).map((e) => e.c),
    ...authoredKeys,
  ]);
  try { if (excludeFile) atomicWrite(excludeFile, JSON.stringify([...excludeSet])); } catch {} // stay silent on ENOSPC/EACCES (matches every other write here)

  // Source label for logs + display: always carry the file, qualified by the
  // section when present. A bare `section ?? source` collapses two files
  // sharing a section title ("Notes", "Status") into one indistinguishable
  // label — fatal for blackout forensics, which exist to identify WHICH hit
  // the exclude suppressed.
  const srcLabel = (h: SearchResult): string => (h.section ? `${h.source} › ${h.section}` : h.source);

  // Calibration log. `extra` carries mode + timing (sync: pipeMs; async:
  // offPathMs/queryToServeMs/fastMs) so the jsonl records both paths uniformly.
  const logCalibration = (
    chunks: SearchResult[],
    extra: Record<string, unknown>,
    servedQuery?: { search?: string; rerankQuery?: string },
  ): void => {
    try {
      // Async injection lags ~1 fire, so a drained row's hits were reranked
      // against a PRIOR query, not this fire's. When the worker echoes back the
      // query it actually served, log THAT — otherwise the row pairs this fire's
      // `search` with the prior query's `hits` and any retrieval-quality read of
      // the log is judging the wrong query. This fire's own query isn't lost: it
      // was just enqueued and will surface as the served query of a later drain.
      const logSearch = servedQuery?.search ?? search;
      const logRerank = servedQuery?.rerankQuery ?? rerankQuery;
      appendFileSync(getCalibrationLog(), JSON.stringify({
        // sid segments fires by session — without it the N2 blind-cycle
        // adjacency test can't tell a real post-injection blackout from two
        // unrelated sessions interleaved in this shared flat log.
        ts: new Date().toISOString(), sid: sid || null, event, tool: env.tool_name ?? null,
        search: logSearch.slice(0, 300), rerankQuery: logRerank.slice(0, 200),
        n: chunks.length, ms: Date.now() - t0,
        scores: chunks.map((h) => Number(h.score.toFixed(3))), // back-compat: final score
        sources: chunks.map(srcLabel),
        // Per-STAGE breakdown so calibration sweeps can see WHY a hit ranked, not just
        // the conflated final: rerank (final cross-encoder), rrf (fused recall), recency factor.
        hits: chunks.map((h) => ({
          src: srcLabel(h),
          rerank: Number(h.score.toFixed(3)),
          rrf: h.rrf != null ? Number(h.rrf.toFixed(4)) : null,
          recency: h.recency != null ? Number(h.recency.toFixed(3)) : null,
          wRank: h.wRank ?? null,
          mmrPick: h.mmrPick ?? null,
          mmrSim: h.mmrSim != null ? Number(h.mmrSim.toFixed(3)) : null,
          ageDays: h.timestamp ? Math.round((Date.now() - Date.parse(h.timestamp)) / 86_400_000) : null,
        })),
        ...extra,
      }) + "\n");
    } catch {}
  };

  // Format + emit a recall block, then exit. additionalContext -> model;
  // systemMessage -> user (so the human sees exactly what the model got, plus
  // the latency `tag`). RAW content is injected (scrubbing is query-only).
  const emitHits = (chunks: SearchResult[], tag: string): never => {
    // Record an access event per injected chunk (step 2: "surfaced" = touched).
    // This is the single injection point for both sync + async-drain paths.
    recordAccess(chunks.map(memKey), "surfaced", new Date().toISOString());
    // Age visibility: show each hit's age. Recency is a PRE-rerank candidate-
    // selection bias (Porrima placement), so the displayed score is the pure
    // cross-encoder relevance — an old hit with a high score survived on merit,
    // which is the gentler behavior we want to see. Entities are evergreen.
    // Age shown = effective last_accessed (surfacing bumps the clock — Porrima
    // semantics), NOT the content-created date. Intentional; labeled "seen" below.
    const ageLabel = (ts?: string): string => {
      if (!ts) return "evergreen";
      const d = (Date.now() - Date.parse(ts)) / 86_400_000;
      return Number.isNaN(d) ? "evergreen" : d < 1 ? "<1d ago" : `${Math.round(d)}d ago`;
    };
    const halfLife = envNum("MACRODATA_RECALL_HALFLIFE_DAYS", 30, 0.1);
    // One row format for BOTH surfaces (model additionalContext + human
    // systemMessage): per-STAGE numbers so neither reader judges calibration on
    // the conflated final. rerank = final cross-encoder; rrf = fused recall score
    // (pre-rerank); rec = recency factor (0-1, pre-rerank selection only); "seen" =
    // effective last_accessed age that rec decays from (surfacing bumps it —
    // Porrima semantics). The model-facing verdict loop needs the same stage
    // breakdown the human sees, or its journaled verdicts cite only the final score.
    // mmr segment: pick order + redundancy penalty at pick time. Omitted (not
    // defaulted) when absent — absence means MMR was bypassed for that slate.
    // An absent stage value renders as "?" (unknown — e.g. a version-skewed
    // inbox), never as a fabricated 0/1 that reads as a measured score.
    const fmt = (v: number | undefined, digits: number) => (v != null ? v.toFixed(digits) : "?");
    // w# = pre-MMR rank by retrieval+recency weight — the counterfactual
    // plain-top-k position. w# above the pool size = MMR created this slot.
    const mmrSeg = (h: SearchResult) =>
      h.mmrPick != null ? ` · mmr (#${h.mmrPick} · w#${h.wRank ?? "?"} · sim ${fmt(h.mmrSim, 2)})` : "";
    // Raw content can quote the literal closing tag (the corpus holds web pages
    // and transcripts); escape it so a hit can't terminate the model-facing
    // block early and pass itself off as post-recall context.
    const excerpt = (s: string) =>
      s.replace(/\s+/g, " ").split("</macrodata-recall").join("<\\/macrodata-recall").slice(0, 220);
    const row = (h: SearchResult) =>
      `- rerank ${h.score.toFixed(2)} · rrf ${fmt(h.rrf, 3)}${mmrSeg(h)} · rec (${fmt(h.recency, 2)} · seen ${ageLabel(h.timestamp)}) — ${srcLabel(h)}\n  ${excerpt(h.content)}`;
    const block = "<macrodata-recall>\n" + chunks.map(row).join("\n") + "\n</macrodata-recall>";
    const debugBlock = chunks.map(row).join("\n");
    // Sampled calibration prompt: on ~VERDICT_RATE of injections, ask the agent to
    // journal a usefulness verdict. Goes in additionalContext (model-facing) so the
    // agent acts on it; the human sees a marker in systemMessage. Reinstates the
    // first-iteration ambient-memory-calibration loop (cf. feedback_ambient_calibration),
    // now sampled to avoid flooding the turn.
    const askVerdict = VERDICT_RATE > 0 && Math.random() < VERDICT_RATE;
    const verdictGuidance = askVerdict
      ? `\n<recall-calibration sampled="~${Math.round(VERDICT_RATE * 100)}%">\n` +
        `Were any of the above relevant to what you're doing right now? Before the turn ends, ` +
        `log a one-line verdict via log_journal(topic="ambient-memory-calibration"): the scores + ` +
        `useful | off-topic + why. (Sampled, so it won't fire every recall.)\n</recall-calibration>`
      : "";
    const visible = `[macrodata-recall] ${chunks.length} hit(s) from ${env.tool_name ?? event} · recency ${halfLife}d half-life · ${tag}${askVerdict ? " · ⊙ verdict requested" : ""}\n${debugBlock}`;
    process.stdout.write(JSON.stringify({
      systemMessage: visible,
      hookSpecificOutput: { hookEventName: event, additionalContext: block + verdictGuidance },
    }));
    process.exit(0);
  };

  // ---- STOP = PRIME-ONLY, in EVERY mode. Enqueue the just-ended turn's
  // context so the worker reranks during the idle gap before the user's next
  // prompt — but DON'T drain or inject. Two reasons: (1) a Stop hook emitting
  // additionalContext can re-trigger the turn → loop (mode-independent: the
  // sync path must not inject on Stop either); (2) draining without injecting
  // would throw away a computed result. The next UserPromptSubmit drains this
  // primed inbox → near-zero felt latency. (Trivial turns were already filtered
  // by the thinking/text gate above, so we only prime substantial turns.)
  if (event === "Stop") {
    if (sid) {
      try {
        atomicWrite(getRequestPath(sid),
          JSON.stringify({ sid, search, rerankQuery, ts: new Date().toISOString(), primedBy: "Stop" }));
      } catch {}
      logCalibration([], { mode: "stop-prime" });
    }
    emitSilent(); // zero output → cannot loop
  }

  // ---- ASYNC mode (default): drain the inbox (a PRIOR fire's results), enqueue
  // THIS query for the worker, exit fast. The slow rerank never blocks the tool;
  // results surface one fire later (3fz competitive injection).
  if (MODE === "async") {
    const inbox = sid ? getInboxPath(sid) : "";
    let ready: SearchResult[] = [];
    let meta: { requestedAt?: string; servedAt?: string; pipelineMs?: number; servedSearch?: string; servedRerankQuery?: string } = {};
    // Drain accounting (feeds calibration): `drained` = hits the worker had
    // waiting; `filteredInContext` = how many of those the in-context exclude
    // dropped before injection. A one-cycle blind spot (the N2 post-injection
    // blackout) shows up here as drained>0 with filteredInContext===drained and
    // n:0 — the signature that was previously unattributable in the soak logs.
    let drained = 0;
    let filteredInContext = 0;
    // WHICH hits the exclude suppressed (source labels, <= worker limit) — a
    // blackout row needs identities, not just a count, to tell true N2 (the
    // just-injected chunk re-won) from an exclude false positive.
    let filteredSrc: string[] = [];
    // Hits the FLOOR re-check (or a malformed score) dropped after the exclude
    // accounting — without this counter a floor-dropped hit leaves a drain row
    // (drained>0, filteredInContext<drained, n:0) matching no documented
    // signature, and a mixed row would fail the N2 test even when N2 fired.
    let floorDropped = 0;
    // A malformed claimed-inbox parse would otherwise log as drained:0 — byte-
    // identical to "worker hadn't served yet" — misattributing a destroyed
    // result to worker latency. (A rename ENOENT is NOT this: that's a
    // concurrent fire winning the claim, handled silently below.)
    let drainError = false;
    if (inbox && existsSync(inbox)) {
      // Claim-by-rename BEFORE reading: parallel tool calls fire concurrent
      // same-sid hooks (the reason atomicWrite's tmp is pid-unique), and a
      // bare read→unlink would let two fires drain the same complete inbox —
      // double-injecting, double-counting recordAccess (which feeds back into
      // recency ranking), and landing duplicate calibration rows. rename is
      // atomic: exactly one fire wins; the loser's ENOENT means "nothing
      // ready", not an error.
      const claim = `${inbox}.${process.pid}.claim`;
      let claimed = false;
      // Only ENOENT means "a concurrent fire won the claim". Any other rename
      // failure (EACCES/EROFS/...) means the inbox exists but can never be
      // claimed — without the flag that strands the inbox forever while the
      // log shows drained:0, the exact worker-latency misattribution the
      // drainError flag exists to prevent.
      try { renameSync(inbox, claim); claimed = true; }
      catch (e) { if ((e as { code?: string }).code !== "ENOENT") drainError = true; }
      if (claimed) {
        try {
          const parsed = JSON.parse(readFileSync(claim, "utf-8")) as
            { requestedAt?: string; servedAt?: string; pipelineMs?: number; servedSearch?: string; servedRerankQuery?: string; hits: SearchResult[] };
          const raw = parsed.hits || [];
          drained = raw.length;
          const kept = raw.filter((h) => !excludeSet.has(h.content));
          filteredInContext = drained - kept.length;
          filteredSrc = raw.filter((h) => excludeSet.has(h.content)).map(srcLabel);
          // Re-apply this process's FLOOR too, not just LIMIT: hook and worker
          // read separate environments, and on skew a tightened hook floor must
          // not be bypassed by hits the worker admitted under its looser one.
          // The typeof guards keep a version-skewed inbox (string scores,
          // missing content/source) from reaching h.score.toFixed(),
          // memKey's sha1 update, or persistInjected downstream — each of
          // which would crash the hook (a skewed inbox is an EXPECTED case —
          // degrade, don't squeak), and persistInjected runs
          // BEFORE emitHits, so a crash there would also write a phantom
          // exclude for content the model never saw.
          const floored = kept.filter((h) =>
            typeof h.content === "string" && typeof h.source === "string" &&
            typeof h.score === "number" && h.score >= FLOOR);
          floorDropped = kept.length - floored.length;
          ready = floored.slice(0, LIMIT);
          meta = parsed;
        } catch {
          drainError = true;
          // Keep the evidence: a malformed CLAIMED file is post-atomic-rename,
          // so it's an anomaly worth an autopsy (version skew? worker bug?) —
          // unlinking it would leave the drainError row undiagnosable. The
          // .bad file joins the deferred tmp/claim litter sweep.
          try { renameSync(claim, `${claim}.bad`); } catch {}
        }
        try { unlinkSync(claim); } catch {} // no-op (ENOENT) when renamed to .bad
      }
    }
    // Enqueue THIS turn's context for the worker (latest-wins; worker consumes).
    if (sid) {
      try { atomicWrite(getRequestPath(sid),
        JSON.stringify({ sid, search, rerankQuery, ts: new Date().toISOString() })); } catch {}
    }
    if (ready.length > 0) {
      // Span: when the served query was enqueued → when the worker served it.
      // offPath = the rerank cost the tool call NEVER paid; fast = what this
      // hook invocation actually cost (the only latency the agent felt).
      const fastMs = Date.now() - t0;
      const offPath = meta.pipelineMs ?? 0;
      const t1 = meta.requestedAt ? Date.parse(meta.requestedAt) : NaN;
      const t2 = meta.servedAt ? Date.parse(meta.servedAt) : NaN;
      const clk = (iso?: string) => (iso ? iso.slice(11, 23) : "?"); // HH:MM:SS.mmm
      const span = Number.isFinite(t1) && Number.isFinite(t2) ? `${t2 - t1}ms` : "?";
      const tag =
        `async · saved ~${offPath}ms off-path (this fire ${fastMs}ms) · ` +
        `query ${clk(meta.requestedAt)} → served ${clk(meta.servedAt)} (${span})`;
      logCalibration(
        ready,
        { mode: "async", offPathMs: offPath, queryToServeMs: span, fastMs, drained, filteredInContext, filteredSrc, floorDropped, excludeSize: excludeSet.size, drainError },
        { search: meta.servedSearch, rerankQuery: meta.servedRerankQuery },
      );
      persistInjected(ready);
      emitHits(ready, tag);
    }
    // Nothing to inject this fire, but we enqueued the current context for the
    // worker. Surface the enqueue (log + UI) so the async lifecycle is visible —
    // but WITHOUT additionalContext, so the model isn't fed empty noise. (When
    // there's no sid we couldn't enqueue, so stay truly silent.)
    if (sid) {
      const fastMs = Date.now() - t0;
      // Pass the served query here too: when the exclude filtered EVERYTHING
      // (drained>0, n:0 — the N2 blackout signature this row exists to catch),
      // the counters must pair with the query that produced the suppressed
      // hits, not this fire's. On a pure-enqueue row meta is {} and the
      // undefined fields fall back to this fire's query, which is then correct.
      logCalibration(
        [],
        { mode: "async-enqueue", fastMs, drained, filteredInContext, filteredSrc, floorDropped, excludeSize: excludeSet.size, drainError },
        { search: meta.servedSearch, rerankQuery: meta.servedRerankQuery },
      );
      const visible = `[macrodata-recall] queued from ${env.tool_name ?? event} · reranking off-path, nothing ready yet (this fire ${fastMs}ms)`;
      process.stdout.write(JSON.stringify({
        systemMessage: visible,
        hookSpecificOutput: { hookEventName: event },
      }));
      process.exit(0);
    }
    emitSilent();
  }

  // ---- SYNC mode (MACRODATA_RECALL_MODE=sync, or --query): run the full
  // pipeline inline — loads the GGUF models IN THIS per-fire process. Debug and
  // manual-CLI use only; wired sessions should always run async.
  let hits: SearchResult[] = [];
  const tPipe = Date.now();
  try {
    hits = await pipelineSearch(search, { limit: LIMIT, floor: FLOOR, rerankQuery, exclude: excludeSet });
  } catch {
    emitSilent(); // servers down / error — never block the tool
  }
  const pipeMs = Date.now() - tPipe;
  logCalibration(hits, { mode: "sync", pipeMs });
  if (hits.length === 0) emitSilent(); // nothing fresh + relevant
  persistInjected(hits);
  emitHits(hits, `${Date.now() - t0}ms (pipeline ${pipeMs}ms)`);
}

// Intentional squeak, not an accident of a floating promise: an unexpected
// throw prints one attributed line + the stack and exits 1 (non-blocking,
// user-visible) instead of surfacing as a bare unhandled-rejection dump.
main().catch((e) => {
  console.error(`[macrodata-recall] hook failed (unexpected): ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
