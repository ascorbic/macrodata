---
"macrodata": patch
---

Migrate from `@xenova/transformers` to `@huggingface/transformers` (replicates ascorbic/macrodata#35). Modern sharp (0.34) ships prebuilt binaries with no postinstall script, so bun's blocked-lifecycle-script behavior can no longer break the native binary install — including in consumers that install the plugin through a generated wrapper package (Claude Code / OpenCode plugin cache), where `trustedDependencies` from this repo does not apply. Same model, same 384-dim embeddings; existing indexes stay valid. The daemon also lazy-loads the indexing modules so its PID file appears in a few hundred ms instead of several seconds.
