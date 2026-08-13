/**
 * CLI: rebuild the ambient-recall Qwen3/1024 index from macrodata markdown.
 *   bun run bin/recall-reindex.ts               full rebuild (re-embeds everything)
 *   bun run bin/recall-reindex.ts --prune-only  drop orphaned vectors, no embedding
 *
 * Safe to run repeatedly — writes only to the recall index dir, printed on
 * startup. For a truly clean rebuild (e.g. after changing the embedding model),
 * delete that dir first: rm -rf "<state root>/.recall/index"
 *
 * --prune-only skips the embedding pass, so it finishes in seconds against an
 * index a full rebuild takes minutes to walk.
 */

import { rebuildIndex, pruneOrphans } from "../src/recall/indexer.ts";
import { getMacrodataRoot, getIndexDir } from "../src/recall/config.ts";

console.log(`[macrodata-recall]data root: ${getMacrodataRoot()}`);
console.log(`[macrodata-recall]index dir: ${getIndexDir()}`);

if (process.argv.includes("--prune-only")) {
  const { pruned, kept } = await pruneOrphans();
  console.log(`[macrodata-recall]✓ pruned ${pruned} orphaned vectors, ${kept} live items remain`);
} else {
  const { itemCount, pruned } = await rebuildIndex();
  console.log(`[macrodata-recall]✓ indexed ${itemCount} items, pruned ${pruned} orphaned vectors`);
}
