/**
 * CLI: rebuild the spike's Qwen3/1024 index from macrodata markdown.
 *   bun run reindex.ts               full rebuild (re-embeds everything)
 *   bun run reindex.ts --prune-only  drop orphaned vectors, no embedding
 *
 * Safe to run repeatedly — writes only to this dir's .index. For a
 * truly clean rebuild (e.g. after changing the embedding model), delete that
 * dir first: rm -rf .index && bun run reindex.ts
 *
 * --prune-only skips the embedding pass, so it finishes in seconds against an
 * index a full rebuild takes minutes to walk.
 */

import { rebuildIndex, pruneOrphans } from "./indexer.ts";
import { getMacrodataRoot, getIndexDir } from "./config.ts";

console.log(`[spike] data root: ${getMacrodataRoot()}`);
console.log(`[spike] index dir: ${getIndexDir()}`);

if (process.argv.includes("--prune-only")) {
  const { pruned, kept } = await pruneOrphans();
  console.log(`[spike] ✓ pruned ${pruned} orphaned vectors, ${kept} live items remain`);
} else {
  const { itemCount, pruned } = await rebuildIndex();
  console.log(`[spike] ✓ indexed ${itemCount} items, pruned ${pruned} orphaned vectors`);
}
