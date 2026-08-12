---
"macrodata": patch
---

Structured logging via LogTape across the plugin proper. Library modules (`indexer`, `conversations`, `embeddings`, `rerank`) now log NDJSON records under per-module `macrodata.*` categories, routed by whichever entrypoint configured a sink: the MCP server sends diagnostics to stderr, and the daemon appends them to `.daemon.log` (which also captures indexer/conversations records that previously vanished into the daemon's discarded stdout). Fixes a protocol bug: `manage_index` rebuild/update completions were `console.log`ged onto the MCP server's stdout, which is the JSON-RPC channel. In unconfigured processes (hook scripts, tests) records drop silently, so model-load and index chatter can no longer leak into hook output.
