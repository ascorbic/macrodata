---
"macrodata": minor
---

Ambient memory recall (beta, opt-in): on UserPromptSubmit / PostToolUse / Stop, a hook asks a local retrieval pipeline for memories relevant to the current context and injects hits on the next opportunity via a file-mailbox protocol. Dual-leg retrieval (Vectra vector + FTS) with RRF fusion, last-accessed recency bias, and Qwen3 cross-encoder rerank — running fully in-process on Metal via node-llama-cpp 3.19.1 (one background worker, no llama-server processes). Off by default: lives under `spike/ambient-recall-nlc/` and runs only where the hooks are wired via `.claude/settings.local.json`. `MACRODATA_RECALL_MODE` picks async (default — models live only in the worker) vs sync (inline, debug-only). Soak + a backtest harness gate the reification into the installed plugin.
