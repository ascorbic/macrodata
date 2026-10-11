---
"@macrodata/opencode": patch
---

Pass a schedule's `model` to `claude --print` as `--model`. The field was already accepted by the schedule tools and honoured for opencode, but a claude run ignored it and always used the default model.
