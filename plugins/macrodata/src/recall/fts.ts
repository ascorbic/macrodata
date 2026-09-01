/**
 * FTS (BM25-lite) + RRF fusion over the ambient-recall index.
 *
 * FTS leg: in-memory IDF-weighted term scoring over each item's content (rare
 * tokens like "asa"/"porrima" outweigh "memory"/"system"). Vector leg: the
 * existing searchMemory(). Fused via Reciprocal Rank Fusion (K=60), same as
 * Porrima.
 *
 * Standing limits, all deliberate: no stemming, no SQLite FTS5, and the corpus
 * is rebuilt per process (~160ms). That last one is affordable only because the
 * worker is long-lived — anything that runs the pipeline per fire pays it every
 * time.
 */

import { LocalIndex } from "vectra";
import { statSync } from "fs";
import { join } from "path";
import { getIndexDir, getEntitiesDir } from "./config.ts";
import { searchMemory, resetIndexCache, type SearchResult } from "./indexer.ts";
import { loadAccessOverlay, memKey } from "./access.ts";
import { rankContext } from "./models.ts";

// All env knobs parse through here: bare Number("") is 0 and Number("typo") is
// NaN, and a NaN pool size makes mmrSelect return [] on every query — ambient
// recall dying silently in the long-lived worker with nothing in the logs.
// Out-of-range values keep the default and squeak per read (squeaky-gate: a
// misconfiguration should announce itself until fixed, not degrade quietly).
export function envNum(name: string, fallback: number, min: number, max = Infinity): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number(raw);
  // A ceiling matters for the same reason the floor does: these knobs feed
  // setTimeout and unbounded allocations, where an absurd value fails in a way
  // that looks nothing like a bad setting — a timer that overflows fires
  // immediately, a pool of a million candidates reranks until the deadline. An
  // out-of-range value is rejected rather than clamped so the warn names the
  // real setting instead of silently running something the operator never asked
  // for.
  if (!Number.isFinite(n) || n < min || n > max) {
    const range = max === Infinity ? `>= ${min}` : `between ${min} and ${max}`;
    console.warn(`[fts] ${name}="${raw}" invalid (need a finite number ${range}); using ${fallback}`);
    return fallback;
  }
  return n;
}

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
// content -> embedding, for MMR's similarity leg. Built from the same
// listItems() pass as the corpus (every candidate from EITHER leg lives in the
// index, so this one map covers both — searchMemory discards vectors and the
// FTS leg never had them). ~20MB at 2.4k items x 1024 dims — a second copy of
// the vectors the cached LocalIndex already holds in memory, so ~40MB combined:
// still trivial next to the loaded GGUFs in the long-lived worker.
let contentVec: Map<string, number[]> | null = null;

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
    contentVec = null;
    resetIndexCache();
    corpusStamp = stamp;
  }
}

async function buildCorpus(): Promise<void> {
  const idx = new LocalIndex(join(getIndexDir(), "vectors"));
  const items = await idx.listItems();
  contentVec = new Map();
  corpus = items.map((it) => {
    const m = it.metadata as Record<string, unknown>;
    const content = (m.content as string) ?? "";
    // Skip empty content: distinct empty items would collapse onto the "" key
    // and hand each other's vectors out.
    if (content && it.vector?.length) contentVec!.set(content, it.vector);
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

export interface PoolCandidate {
  item: SearchResult;
  rrf: number;
  rec: number;
  w: number;
  vector?: number[];
  // 1-based rank in the w-sorted slate, stamped by pipelineSearch BEFORE MMR
  // runs: the counterfactual "plain top-k by score" position. wRank > pool
  // size means MMR created this candidate's rerank slot (it displaced a
  // higher-w near-duplicate); without it, pick order alone can't distinguish
  // a penalized-but-strong candidate from a genuinely displaced-in one.
  wRank?: number;
  // Stamped by mmrSelect on the greedy path only: pick = 1-based selection
  // order; maxSim = the redundancy penalty the candidate carried when picked
  // (0 for the first pick). Absent = MMR was bypassed (small slate or
  // lambda >= 1), which the diagnostics surface deliberately.
  mmr?: { pick: number; maxSim: number };
}

// Similarity leg of MMR: cosine over the index embeddings (Porrima's metric,
// same qwen3-embedding family — so its lambda values transfer at face value),
// with Jaccard over terms() token sets as the degraded path when a vector is
// missing (contentVec unbuilt after an FTS-leg failure). Cosine matters
// because journal redundancy is often PARAPHRASE — same fact, different
// words — which token overlap cannot see.
function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

// MMR pool selection (Porrima's passive-recall placement: mmrRerank at
// lambda=0.55 BEFORE the cross-encoder — memory-storage.ts:927,
// passive-memory-recall.ts:489): greedy diverse selection deciding which
// candidates earn a rerank slot, so the expensive precision pass stops
// spending slots on near-duplicates. Relevance = the recency-adjusted RRF
// weight `w`, min-max normalized within the slate: raw RRF magnitudes (~1/60)
// would let the (1-lambda) similarity term swamp relevance at any lambda,
// making lambda a dead knob. (Min-max pins the slate's top to 1 and its last
// to 0 — the weakest candidate competes on novelty alone, which is the
// intent.) Input order doesn't matter; lambda >= 1 degenerates to plain top-k
// (same short-circuit as Porrima).
export function mmrSelect(slate: PoolCandidate[], k: number, lambda: number): PoolCandidate[] {
  if (slate.length <= k) return slate.slice(0, k);
  if (lambda >= 1) return [...slate].sort((a, b) => b.w - a.w).slice(0, k);
  // NaN or negative lambda would corrupt or INVERT the scoring (a negative
  // relevance weight rewards redundancy); clamp to pure-diversity instead.
  if (!(lambda >= 0)) lambda = 0;
  let wMax = -Infinity, wMin = Infinity;
  for (const c of slate) {
    if (c.w > wMax) wMax = c.w;
    if (c.w < wMin) wMin = c.w;
  }
  const range = wMax - wMin;
  const relevance = (c: PoolCandidate) => (range > 0 ? (c.w - wMin) / range : 1);
  const tokens = new Map<PoolCandidate, Set<string>>(
    slate.map((c) => [c, new Set(terms(c.item.content))]),
  );
  // Cosine only for a well-formed pair: a dim-mismatched or NaN-bearing vector
  // (possible after an embedding-model change without an index wipe) must not
  // yield sim 0 and read as maximally novel — degrade that pair to Jaccard.
  const sim = (a: PoolCandidate, b: PoolCandidate): number => {
    if (a.vector && b.vector && a.vector.length === b.vector.length) {
      const c = cosine(a.vector, b.vector);
      if (Number.isFinite(c)) return c;
    }
    return jaccard(tokens.get(a)!, tokens.get(b)!);
  };

  // Greedy selection: first pick is the highest-relevance candidate; each
  // later pick maximizes lambda * relevance - (1 - lambda) * maxSim against
  // the picks so far. maxSim clamps at 0 (Porrima does the same): negative
  // cosine means "very diverse", which must not become a relevance bonus.
  const selected: PoolCandidate[] = [];
  const pickSim: number[] = [];
  const remaining = [...slate];
  while (selected.length < k && remaining.length > 0) {
    if (selected.length === 0) {
      let first = 0;
      for (let i = 1; i < remaining.length; i++) if (remaining[i].w > remaining[first].w) first = i;
      selected.push(remaining.splice(first, 1)[0]);
      pickSim.push(0);
      continue;
    }
    let bestIdx = 0;
    let bestScore = -Infinity;
    let bestMaxSim = 0;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let maxSim = 0;
      for (const s of selected) {
        const v = sim(c, s);
        if (v > maxSim) maxSim = v;
      }
      const score = lambda * relevance(c) - (1 - lambda) * maxSim;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
        bestMaxSim = maxSim;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]);
    pickSim.push(bestMaxSim);
  }
  // Copies, stamped after the loop: `sim` keys the Jaccard token map by object
  // identity, so the originals must flow through selection untouched.
  return selected.map((c, i) => ({ ...c, mmr: { pick: i + 1, maxSim: pickSim[i] } }));
}

// Full pipeline (Porrima placement): vector + FTS recall -> RRF fuse ->
// recency-biased + MMR-diversified candidate SELECTION -> cross-encoder
// rerank -> floor on the PURE rerank score. Recency and diversity decide
// which candidates earn a rerank slot; they never touch the final ranking, so
// a stale-but-strongly-relevant memory that survives into the pool still wins
// on pure relevance.
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
  // Leg width: Porrima's passive searchLimit tiers are 28/40/64
  // (fast/balanced/thorough); 40 matches balanced. Widening is free at query
  // time — vectra's queryItems scores every item and slices, and the FTS leg
  // scans the full corpus regardless of the requested limit. Keep
  // MACRODATA_RECALL_RERANK_POOL below the fused slate size (legK * 2) or the
  // pool-selection stage goes vacuous and recency/MMR silently stop gating.
  const legK = envNum("MACRODATA_RECALL_LEG_K", 40, 1);
  let vec: SearchResult[] = [];
  try {
    vec = await searchMemory(query, { limit: legK, task });
  } catch (e) {
    console.warn(`[fts] vector leg failed, continuing FTS-only: ${String(e)}`);
  }
  let fts: SearchResult[] = [];
  try {
    fts = await ftsSearch(query, legK);
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
  const halfLifeDays = envNum("MACRODATA_RECALL_HALFLIFE_DAYS", 30, 0.1);
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
  const pool = envNum("MACRODATA_RECALL_RERANK_POOL", 20, 1);
  const lambda = envNum("MACRODATA_RECALL_MMR_LAMBDA", 0.55, 0);
  const slate = [...fused.values()]
    .map((x) => { const rec = recency(lastAccessed(x.item)); return { item: x.item, rrf: x.rrf, rec, w: x.rrf * rec, vector: contentVec?.get(x.item.content) } as PoolCandidate; })
    .sort((a, b) => b.w - a.w);
  slate.forEach((c, i) => { c.wRank = i + 1; });
  const candidates = mmrSelect(slate, pool, lambda);

  // Rerank the pool; the PURE cross-encoder score is the final score. Carry the
  // per-stage diagnostics (rrf recall score, recency factor) through UNCHANGED so
  // the hook + calibration log can show each stage instead of conflating into the
  // final. Stamp effective last_accessed so the age label shows the real age.
  let scores: number[];
  try {
    scores = await rerank(rerankQuery || query, candidates.map((c) => c.item.content));
  } catch (e) {
    // The two recall legs above degrade into each other; this stage has nothing
    // to degrade to. `floor` and the final ordering are both defined in terms of
    // the cross-encoder's score, and the fused RRF rank is not on that scale, so
    // substituting it would publish hits under a number that means something
    // else — into the calibration log, whose whole purpose is comparing those
    // numbers across runs. Recall is best-effort; returning nothing is a cost
    // the caller already handles.
    console.warn(`[fts] rerank failed, returning no hits: ${String(e)}`);
    return [];
  }
  return candidates
    .map((c, i) => ({ ...c.item, score: scores[i], rrf: c.rrf, recency: c.rec, wRank: c.wRank, mmrPick: c.mmr?.pick, mmrSim: c.mmr?.maxSim, timestamp: lastAccessed(c.item) }))
    .filter((c) => c.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
