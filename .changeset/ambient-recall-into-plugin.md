---
"macrodata": minor
---

Ship ambient recall as part of the plugin instead of a sidecar checkout.

The retrieval pipeline (Qwen3-Embedding-0.6B / 1024-dim via node-llama-cpp) moves
into `src/recall/`, its entry points into `bin/recall-{hook,supervisor,reindex,search}`,
and its hooks are registered in `plugin.json` — so a marketplace install gets ambient
recall with no manual `settings.json` wiring.

Runtime state now resolves through the shared `getStateRoot()` and lives under
`<root>/.recall/` (index, per-session mailbox, calibration, access log, worker logs).
Previously it was written next to the source, which only worked for a fixed checkout
path: plugins install into a per-version cache dir, so a source-relative index would
be orphaned on every release. The leading dot keeps it inside the state root's
existing "dotfiles are runtime, plain dirs are memory content" ignore rule.

This also corrects the data root for anyone who is not the original author — the
sidecar hardcoded `~/Documents/macrodata` rather than honoring `MACRODATA_ROOT` and
`~/.config/macrodata/config.json`.

Ambient recall keeps its own index: it embeds at 1024 dimensions while the MCP server
uses MiniLM at 384, so the two cannot share a Vectra store.

Upgrading from a hand-wired sidecar: kill any worker started by the old supervisor once
(`pkill -f recall/worker.ts`) and drop the recall entries from `settings.json`. The new
supervisor identifies its workers by an argv sentinel rather than by script path — which
is what lets it reap the previous plugin version's worker on every future update — so a
worker predating this change is invisible to it and would keep draining the same mailbox
alongside the new one.
