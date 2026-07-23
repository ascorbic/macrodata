/**
 * Hacky FTS (BM25-lite) + RRF fusion over the spike index — to A/B test the
 * hybrid theory before committing to a real SQLite FTS5 leg.
 *
 * FTS leg: in-memory IDF-weighted term scoring over each item's content (rare
 * tokens like "asa"/"porrima" outweigh "memory"/"system"). Vector leg: the
 * existing searchMemory(). Fused via Reciprocal Rank Fusion (K=60), same as
 * Porrima. NOT production — no stemming, no SQLite, corpus rebuilt per process.
 */

import { LocalIndex } from "vectra";
import { statSync } from "fs";
import { join } from "path";
import { getIndexDir, getEntitiesDir } from "./config.ts";
import { searchMemory, resetIndexCache, type SearchResult } from "./indexer.ts";
import { loadAccessOverlay, memKey } from "./access.ts";
import { rankContext } from "./models.ts";

const STOP = new Set(
  "the a an is are was were be by of to in on for and or but with that this it as at from how do does did what why which when who whose into over under not no yes can could would should i we you they them their our your my me".split(" "),
);

function terms(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9_-]+/g) ?? []).filter(
    (t) => t.length > 1 && !STOP.has(t),
  );
}

interface Doc {
  content: string;
  source: string;
  section?: string;
  type: string;
  timestamp?: string; // carried through so the FTS leg's hits decay too (else FTS-only journal items read as evergreen)
  tf: Map<string, number>;
}

let corpus: Doc[] | null = null;
let idf: Map<string, number> | null = null;

// Staleness gate for the long-lived worker: the FTS corpus is built FROM the
// Vectra index, so one index.json mtime covers both caches. On change, drop
// corpus/idf AND the indexer's cached LocalIndex so a reindex is picked up
// without a worker restart.
let corpusStamp = -1;
function checkIndexFresh(): void {
  let stamp = 0;
  try {
    stamp = statSync(join(getIndexDir(), "vectors", "index.json")).mtimeMs;
  } catch {}
  if (stamp !== corpusStamp) {
    corpus = null;
    idf = null;
    resetIndexCache();
    corpusStamp = stamp;
  }
}

async function buildCorpus(): Promise<void> {
  const idx = new LocalIndex(join(getIndexDir(), "vectors"));
  const items = await idx.listItems();
  corpus = items.map((it) => {
    const m = it.metadata as Record<string, unknown>;
    const content = (m.content as string) ?? "";
    const tf = new Map<string, number>();
    for (const t of terms(content)) tf.set(t, (tf.get(t) ?? 0) + 1);
    return { content, source: m.source as string, section: m.section as string | undefined, type: m.type as string, timestamp: m.timestamp as string | undefined, tf };
  });
  const df = new Map<string, number>();
  for (const d of corpus) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const N = corpus.length;
  idf = new Map();
  for (const [t, f] of df) idf.set(t, Math.log(1 + (N - f + 0.5) / (f + 0.5)));
}

export async function ftsSearch(query: string, k = 20): Promise<SearchResult[]> {
  checkIndexFresh();
  if (!corpus || !idf) await buildCorpus();
  const qts = terms(query);
  return corpus!
    .map((d) => {
      let s = 0;
      for (const t of qts) {
        const tf = d.tf.get(t);
        if (tf) s += (idf!.get(t) ?? 0) * (tf / (tf + 1.5)); // tf saturation
      }
      return { d, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, k)
    .map((x) => ({ content: x.d.content, source: x.d.source, section: x.d.section, type: x.d.type, timestamp: x.d.timestamp, score: x.s }));
}

// Cross-encoder rerank IN-PROCESS via node-llama-cpp rankAll (replaces the
// llama-server /v1/rerank HTTP leg). rankAll returns a score per input doc, in
// input order. Doc length capped at 2000 chars (full content is long; quality
// over latency — async hides it). NOTE: rankAll's score scale may differ from
// llama-server's /v1/rerank — re-validate MACRODATA_RECALL_FLOOR against the A/B.
export async function rerank(query: string, docs: string[]): Promise<number[]> {
  if (docs.length === 0) return [];
  const ctx = await rankContext();
  return ctx.rankAll(query, docs.map((d) => d.slice(0, 2000)));
}

// Full pipeline (Porrima placement): vector + FTS recall -> RRF fuse ->
// recency-biased candidate SELECTION -> cross-encoder rerank -> floor on the
// PURE rerank score. Recency decides which candidates earn a rerank slot; it
// never touches the final ranking, so a stale-but-strongly-relevant memory that
// survives into the pool still wins on pure relevance.
export async function pipelineSearch(
  query: string,
  opts: { limit?: number; task?: string; floor?: number; rerankQuery?: string; exclude?: Set<string> } = {},
): Promise<SearchResult[]> {
  const { limit = 5, task, floor = 0.5, rerankQuery, exclude } = opts;
  // Freshness check BEFORE the vector leg — searchMemory uses the cached
  // LocalIndex, so the reset must happen ahead of it, not just in ftsSearch.
  checkIndexFresh();
  // Recall legs use the WIDE query; the rerank precision pass uses the TIGHT
  // query (the agent's current trajectory) when provided, else the same query.
  // BOTH legs read the shared Vectra index — the vector leg via searchMemory,
  // the FTS leg via buildCorpus -> listItems — so EITHER can throw on a torn
  // index.json read during a concurrent reindex (and the vector leg can also
  // throw on a token-dense query exceeding contextSize). Isolate each leg so
  // one failing degrades to the other instead of killing the whole pipeline;
  // an unguarded ftsSearch throw would also discard a successful vector result.
  let vec: SearchResult[] = [];
  try {
    vec = await searchMemory(query, { limit: 20, task });
  } catch (e) {
    console.warn(`[fts] vector leg failed, continuing FTS-only: ${String(e)}`);
  }
  let fts: SearchResult[] = [];
  try {
    fts = await ftsSearch(query, 20);
  } catch (e) {
    console.warn(`[fts] FTS leg failed, continuing vector-only: ${String(e)}`);
  }

  // RRF-fuse the two recall legs into one ranked slate (K=60), keyed by content.
  // Drop already-injected chunks here, BEFORE rerank, so repeats don't occupy
  // the pool and starve fresh chunks.
  const K = 60;
  const fused = new Map<string, { item: SearchResult; rrf: number }>();
  const add = (list: SearchResult[]) =>
    list.forEach((r, i) => {
      if (exclude?.has(r.content)) return;
      const prev = fused.get(r.content);
      fused.set(r.content, { item: prev?.item ?? r, rrf: (prev?.rrf ?? 0) + 1 / (K + i + 1) });
    });
  add(vec);
  add(fts);

  // Recency BEFORE rerank (Porrima placement, verified in source 2026-06-17):
  // Porrima bakes recency into the fused RETRIEVAL score (rrf * recencyDecay *
  // importance * supersession) that picks candidates, then OVERWRITES it with the
  // pure cross-encoder score — recency never gates the final output. We mirror
  // that: recency multiplies the RRF score for selection only. This is gentler
  // than our old after-rerank multiply-then-floor, which imposed a hard age
  // ceiling (a 107d hit at rerank 1.0 still floored out); now that same hit wins
  // if it survives into the pool. halfLife default 30d — matches Porrima now that the
  // decay clock is last_accessed (was 60d when it decayed from created/birthtime).
  //
  // No evergreen class (step 1 of the access-data design — Porrima has none):
  // EVERY item decays. Journal items seed from their created `timestamp`; entities
  // seed from their file BIRTHTIME (creation ≈ Porrima's `created_at`, and unlike
  // mtime it doesn't move on every edit), statted at query time (NOT baked into
  // the shared vectra index — the prod daemon reindexes entities without it and
  // would clobber it). Birthtime is just a BOOTSTRAP: a later step overlays an
  // overlay-owned `firstSeen` + `last_accessed`-on-use, the way Porrima captures
  // created_at once and owns it. A dormant entity fades from ambient recall but
  // stays reachable via explicit search_memory. (Caveat: a move/copy can reset
  // birthtime, so it's a prior, not ground truth.)
  const halfLifeDays = Number(process.env.MACRODATA_RECALL_HALFLIFE_DAYS ?? 30);
  const now = Date.now();
  const entitiesDir = getEntitiesDir();
  const seedCache = new Map<string, string | undefined>();
  const seed = (c: SearchResult): string | undefined => {
    if (c.timestamp) return c.timestamp; // journal: created_at
    if (seedCache.has(c.source)) return seedCache.get(c.source);
    let ts: string | undefined;
    try { ts = statSync(join(entitiesDir, c.source)).birthtime.toISOString(); } catch { ts = undefined; }
    seedCache.set(c.source, ts);
    return ts;
  };
  // Access overlay (step 2): using a memory refreshes its clock. Effective
  // last_accessed = most-recent of (birthtime/created seed, last access event).
  // This is what recency actually decays from — Porrima's last_accessed, not
  // created_at. A perennially-relevant memory stays warm; a never-touched one
  // decays from its seed.
  const overlay = loadAccessOverlay();
  const lastAccessed = (c: SearchResult): string | undefined => {
    const s = seed(c);
    const a = overlay.get(memKey(c))?.lastAccessed;
    if (!s) return a;
    if (!a) return s;
    return a > s ? a : s;
  };
  const recency = (ts?: string): number => {
    if (!ts) return 1; // unresolved seed (stat failed) — neutral, don't over-penalize
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return 1;
    const ageDays = Math.max(0, (now - t) / 86_400_000);
    return Math.pow(0.5, ageDays / halfLifeDays);
  };

  // Pool cap: rerank is the expensive precision stage, so recency-adjusted RRF
  // chooses which top-N candidates to spend it on. A pool >= the slate size makes
  // recency a no-op (everyone gets reranked); tighten it to give recency bite.
  // Seed is precomputed once per candidate (not in the sort comparator) to avoid
  // redundant statSync calls.
  const pool = Number(process.env.MACRODATA_RECALL_RERANK_POOL ?? 20);
  const candidates = [...fused.values()]
    .map((x) => { const rec = recency(lastAccessed(x.item)); return { item: x.item, rrf: x.rrf, rec, w: x.rrf * rec }; })
    .sort((a, b) => b.w - a.w)
    .slice(0, pool);

  // Rerank the pool; the PURE cross-encoder score is the final score. Carry the
  // per-stage diagnostics (rrf recall score, recency factor) through UNCHANGED so
  // the hook + calibration log can show each stage instead of conflating into the
  // final. Stamp effective last_accessed so the age label shows the real age.
  const scores = await rerank(rerankQuery || query, candidates.map((c) => c.item.content));
  return candidates
    .map((c, i) => ({ ...c.item, score: scores[i], rrf: c.rrf, recency: c.rec, timestamp: lastAccessed(c.item) }))
    .filter((c) => c.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
