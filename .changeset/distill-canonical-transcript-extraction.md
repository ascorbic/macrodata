---
"macrodata": patch
---

Give `/distill` a canonical transcript-extraction step instead of asking each sub-agent to "filter to conversation content" on its own. A new bundled filter, `bin/transcript-text.jq`, deterministically converts a raw Claude Code transcript to human + assistant text only — dropping tool calls, tool results, thinking blocks, and harness plumbing (slash-command echoes, `<usage>` telemetry) — and shrinks a transcript ~44x (18MB → ~420KB on a real session). The distill coordinator now pre-extracts each transcript to a `mktemp -d` temp dir and points sub-agents at the clean text. This kills the failure mode where every scheduled run hand-rolled a throwaway JSONL parser and littered the memory root with scratch files.
