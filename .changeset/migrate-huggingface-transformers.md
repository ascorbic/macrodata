---
"@macrodata/opencode": patch
---

Migrate from `@xenova/transformers` to `@huggingface/transformers` (#24). Modern sharp (0.34) ships prebuilt binaries with no postinstall script, so bun's blocked-lifecycle-script behavior can no longer break the native binary install — including in consumers that install the plugin through a generated wrapper package (OpenCode plugin cache), where neither `bunfig.toml` nor `trustedDependencies` from this repo apply. Same model, same 384-dim embeddings; existing indexes stay valid. The daemon also lazy-loads the indexing modules so its PID file appears in ~300ms instead of ~4.6s.
