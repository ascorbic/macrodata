/**
 * Access overlay (step 2 of the access-data design) — an append-only event log
 * that records when a memory is accessed, folded into per-key stats:
 *   - lastAccessed = max ts over REFRESH-kind events (the recency clock)
 *   - firstSeen    = min ts over all events (overlay-owned anchor, ≈ Porrima's
 *                    created_at once an item has been seen)
 *   - count        = total events ("access_count" — tracked free by summing rows;
 *                    Porrima stores but doesn't rank with it, so neither do we yet)
 *
 * Append-only so concurrent processes (hook fires + worker) never clobber; the
 * fold is a cheap one-pass read. The overlay never touches the shared vectra
 * index. Keys are the content sha for BOTH entities and journal entries (content
 * = identity, Caleb 2026-06-24): an edit yields a new key by design. This also
 * sidesteps the positional-id reshuffle entirely — the index id can churn; the
 * access key depends only on content.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import type { SearchResult } from "./indexer.ts";
import { getAccessLog, getRecallDir } from "./config.ts";

// Resolved per call, not memoized at import: the state root is configurable at
// runtime and a long-lived worker must not pin the value it saw at startup.
const LOG = () => getAccessLog();

// Which event kinds advance last_accessed. Step 2 uses "surfaced" (the free
// signal — injected = touched) so the clock moves now. This is a mild positive
// feedback loop, but the Porrima placement dampens it: recency only biases
// candidate SELECTION, never the final rerank, so a surfaced-but-irrelevant memory
// still can't reach the output. Step 3 adds "referenced" (the agent actually used
// it — loop-free) and can drop "surfaced" here via the env override.
const REFRESH_KINDS = new Set(
  (process.env.MACRODATA_RECALL_REFRESH_KINDS ?? "surfaced").split(",").map((s) => s.trim()).filter(Boolean),
);

export function memKey(r: SearchResult): string {
  // Content IS the identity, uniformly (Caleb 2026-06-24): entities key by the same
  // content sha as journals, so an edited section is a genuinely NEW memory (fresh
  // recency/access clock) instead of inheriting the old version's stats through a
  // stable source§section key. Content changed → new unit, by design. (Prefix kept
  // `j:` so existing journal access history still matches — it's an opaque namespace
  // now, not a type tag.)
  return `j:${createHash("sha1").update(r.content).digest("hex").slice(0, 16)}`;
}

export function recordAccess(keys: string[], kind: string, ts: string): void {
  if (keys.length === 0) return;
  try {
    // The recall dir is created on demand: a fresh state root has no .recall/
    // until something writes, and an append to a missing dir would throw.
    mkdirSync(getRecallDir(), { recursive: true });
    appendFileSync(LOG(), keys.map((key) => JSON.stringify({ ts, key, kind })).join("\n") + "\n");
  } catch {}
}

export interface AccessStat {
  firstSeen: string;
  lastAccessed?: string;
  count: number;
}

export function loadAccessOverlay(): Map<string, AccessStat> {
  const m = new Map<string, AccessStat>();
  const log = LOG();
  if (!existsSync(log)) return m;
  let malformed = 0;
  try {
    for (const line of readFileSync(log, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      let e: { ts?: string; key?: string; kind?: string };
      try {
        e = JSON.parse(line);
      } catch {
        malformed++; // log loudly, don't silently swallow (cf. indexer fix #28)
        continue;
      }
      if (!e.key || !e.ts) continue;
      const s = m.get(e.key) ?? { firstSeen: e.ts, count: 0 };
      s.count++;
      // Lexical ISO compare below: all event ts come from ONE writer (recordAccess →
      // toISOString, canonical `…Z`+ms) so lexical == chronological. A backward clock
      // step could mis-set firstSeen/lastAccessed → under-recall (safe direction).
      if (e.ts < s.firstSeen) s.firstSeen = e.ts;
      if (e.kind && REFRESH_KINDS.has(e.kind) && (!s.lastAccessed || e.ts > s.lastAccessed)) s.lastAccessed = e.ts;
      m.set(e.key, s);
    }
  } catch {}
  if (malformed > 0) console.warn(`[Access] skipped ${malformed} malformed event line(s) in ${log}`);
  return m;
}
