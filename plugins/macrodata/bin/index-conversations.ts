#!/usr/bin/env bun
/**
 * Index conversations incrementally
 *
 * Called by hooks at session end / after compact to keep the conversation index fresh.
 */

import { configure, jsonLinesFormatter } from "@logtape/logtape";
import { updateConversationIndex } from "../src/conversations.js";

// Library diagnostics (conversations/embeddings progress + errors) go to
// stderr as NDJSON; stdout stays reserved for the one-line status below so
// the hook harness never sees log noise as output.
await configure({
  sinks: {
    stderr: (record) => process.stderr.write(jsonLinesFormatter(record)),
  },
  loggers: [
    { category: ["macrodata"], lowestLevel: "debug", sinks: ["stderr"] },
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["stderr"] },
  ],
});

async function main() {
  try {
    const result = await updateConversationIndex();
    console.log(`Indexed conversations: ${result.filesUpdated} updated, ${result.skipped} skipped, ${result.exchangeCount} total`);
  } catch (err) {
    console.error("Failed to index conversations:", err);
    process.exit(1);
  }
}

main().catch(console.error);
