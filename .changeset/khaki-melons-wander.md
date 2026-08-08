---
"macrodata": patch
---

Prune vectors whose source items no longer exist, and add `reindex.ts --prune-only` to run that reconcile without re-embedding. The ambient index only ever upserted, so a vector outlived the journal line, section, or file it came from and kept scoring against live material forever — nothing deleted, so the index drifted upward indefinitely. Measured before the fix: 2783 vectors against 2762 real items, and every one of the 21 orphans was a section of a single deleted entity file that kept surfacing at 0.99. That file is the ghost behind a recall misdiagnosis where a superseded entity outranked the correction written to replace it.

Reconciling is cheap in a way rebuilding is not — scanning is file reads, while embedding is the entire cost of a rebuild — so `--prune-only` finishes in about 4 seconds where a full rebuild takes about 13 minutes. An empty scan is refused rather than honored: an unreadable or misconfigured data root produces one far more often than a genuinely empty corpus does, and reconciling against it would delete every vector, recoverable only by re-embedding the whole corpus.
