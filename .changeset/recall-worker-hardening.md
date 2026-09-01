---
"macrodata": patch
---

Recall worker hardening, following the hook-managed worker that shipped in 0.9.0.

The pidfile-claim guard now asks the same question as the `ps` classifier: is this
process a worker *for this state root*? It used to accept any process carrying the
worker sentinel, so a claim held by a neighbouring root's worker — reachable through
pid recycling after a reboot — survived every pass: the guard saw a worker and left
the claim, the classifier saw none for this root and spawned one, and the fresh
worker found the claim held by something alive and stood down. Recall stayed dead in
a state no later pass could undo. One shared predicate now, so there is no second
copy to drift.

A pipeline that never settles is now survivable. It used to be worse than a crash: the
worker stayed in `ps` holding the claim, read as healthy, and made every replacement
stand down while dropping every request. The pipeline now runs under a deadline and the
worker exits when it misses one, so the next pass can start a worker that serves —
20 minutes for a first run that may download models, 2 minutes once they are loaded
(`MACRODATA_RECALL_WEDGE_COLD_MS`, `MACRODATA_RECALL_WEDGE_WARM_MS`). A spawn that dies
during startup is no longer silent either: two consecutive spawns that leave no worker
now say startup is failing instead of logging another clean first start. That count is
deliberately not a time window — a window between attempts measures how fast you type,
and at any real prompt cadence every gap exceeds it.

Also: mailbox files left by sessions that have ended are swept hourly past a 7-day TTL
(only `request-` files were ever consumed, so the directory grew for the life of the
state root and the worker's 5s sweep read all of it), a request file the worker cannot
parse is quarantined instead of left to be found again by every one of those sweeps for
the life of the process, the recall logs are trimmed to their last 512KB past 1MB,
and a `root` in `config.json` that isn't a string falls back to the default in both the
shell and TypeScript resolvers rather than resolving to a bogus path in one and throwing
in the other.

Behavior change worth knowing: when a hand-started worker is running on a state root,
the hook now reaps the *installed* workers on that root. Every worker drains the same
mailbox, so leaving both up made each request a race between two copies of the code.
The hand-started worker is still never killed.

The state root is now canonicalized the same way on both sides. It is an identity and
not only a path — the hook writes it into the worker's argv and later finds that worker
again by comparing strings — so `~/store` and `~/store/` were two identities sharing one
mailbox, each session reading the other's claim as foreign, deleting a live pidfile and
starting a second worker. Trailing slashes are stripped and an existing directory is
resolved through symlinks, so the two spellings converge. A root containing a control
character now falls back to the default instead: `ps` renders a newline as `\012`, so
such a worker can never match its own argv again and every prompt starts another one,
without bound.

Text injected into the model's context is neutralized wherever it comes from, the
detected-user block and the recall status line included. Store content could otherwise
close the wrapper tag around it and have the rest read as the hook's own output. The
neutralizer is one shell function now rather than a pattern repeated per site, which
also removes a portability trap: from bash 5.2 an unescaped `&` in a `${var//…/…}`
replacement expands to the matched text, so the escaping silently produced different
results on macOS's bash 3.2 and on CI.

A reranker that fails now yields no hits rather than hits ordered by the fusion score.
The relevance floor and the calibration log are both defined in the cross-encoder's
scale, so passing along numbers from a different one would have read as a working
recall that had quietly stopped ranking.

Also: a request the worker cannot parse is quarantined under a name carrying the time it
was quarantined, so a second unparseable request in the same session no longer overwrites
the first; `injected-` records are pruned on every prompt rather than only on prompts that
inject something; a claim held by a pid that has exited is cleared, and "no such process"
is now told apart from "not permitted to signal it", which previously read the same;
and a recall budget larger than `setTimeout` can hold is clamped instead of overflowing
into firing immediately, which would have declared every request wedged on arrival.
