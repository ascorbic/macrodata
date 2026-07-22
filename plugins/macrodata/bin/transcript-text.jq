# Canonical Claude Code transcript (.jsonl) -> readable conversation text.
#
# Usage: jq -rn -f transcript-text.jq <transcript.jsonl> > conversation.txt
#
# Emits only human + assistant TEXT, with a "### role" header per turn. Drops,
# in order:
#   - non-conversational line types (system, summary, file-history-snapshot, ...)
#   - non-text content blocks (tool_use, tool_result, thinking)
#   - harness plumbing that rides in as text blocks: slash-command echoes
#     (<command-name>/<command-message>/<command-args>/<local-command-caveat>)
#     and <usage> subagent telemetry.
#
# On a real 18MB / 6109-line session this yields ~420KB of clean text (~44x
# smaller) with zero tool/telemetry noise. Use it instead of hand-writing a
# per-run JSONL parser.
def strip_noise:
  gsub("<usage>.*?</usage>\\n?"; "");
inputs
| select(.type == "user" or .type == "assistant")
| .type as $role
| ( if (.message.content | type) == "string" then [ .message.content ]
    else [ .message.content[] | select(.type == "text") | .text ]
    end )
| map(select(. != null)
      | select(startswith("<command-name>")         | not)
      | select(startswith("<command-message>")      | not)
      | select(startswith("<command-args>")         | not)
      | select(startswith("<local-command-caveat>") | not)
      | strip_noise)
| map(select((. | gsub("\\s"; "")) != "")) as $texts
| ($texts | join("\n")) as $body
| select($body != "")
| "\n### \($role)\n\($body)"
