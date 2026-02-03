#!/usr/bin/env bun
/**
 * Index conversations incrementally
 *
 * Called by hooks at session end / after compact to keep the conversation index fresh.
 */

import { updateConversationIndex } from "../src/conversations.js";

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
