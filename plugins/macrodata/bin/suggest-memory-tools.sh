#!/bin/bash
#
# UserPromptSubmit hook — static reminder that recall tools exist.
#
# Replaces the prior ambient-memory.ts and ambient-memory-qmd.ts hooks, which
# ran retrieval on every prompt. Burn-in data showed both surfaced
# operationally-useful context on <10% of turns while paying 2–28s of latency.
# This hook nudges the model to call the recall tools intentionally instead.
#
# Emits every 11 turns (first turn, then every 11th after) to reduce context
# noise while keeping the nudge alive across long sessions.
#
# Costs ~one shell exec per prompt, no bun startup, no index reads.
#

read -r _stdin  # drain stdin so the harness doesn't see a broken pipe

SESSION="${CLAUDE_CODE_SESSION_ID:-global}"
COUNTER_FILE="/tmp/macrodata-tools-hint-counter-${SESSION}"
INTERVAL=11

count=0
if [[ -f "$COUNTER_FILE" ]]; then
  count=$(<"$COUNTER_FILE")
fi

next=$((count + 1))
printf '%s' "$next" > "$COUNTER_FILE"

if (( count % INTERVAL != 0 )); then
  exit 0
fi

printf '%s' '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<macrodata-tools-hint>For recall of past work, journals, or project context: call `mcp__plugin_macrodata_macrodata__search_memory` (semantic over journals/entities) or `mcp__plugin_macrodata_macrodata__get_recent_journal` (chronological). For lexical+semantic search across local markdown collections (wikis, docs, sources), call `mcp__plugin_qmd_qmd__query`. Skip for trivial or social prompts.</macrodata-tools-hint>"},"systemMessage":"[macrodata] injected reminder about search_memory + qmd recall tools"}'
