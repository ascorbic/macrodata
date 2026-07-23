/**
 * CLI: rebuild the spike's Qwen3/1024 index from macrodata markdown.
 *   bun run reindex.ts
 *
 * Safe to run repeatedly — writes only to this dir's .index. For a
 * truly clean rebuild (e.g. after changing the embedding model), delete that
 * dir first: rm -rf .index && bun run reindex.ts
 */

import { rebuildIndex } from "./indexer.ts";
import { getMacrodataRoot, getIndexDir } from "./config.ts";

console.log(`[spike] data root: ${getMacrodataRoot()}`);
console.log(`[spike] index dir: ${getIndexDir()}`);

const { itemCount } = await rebuildIndex();
console.log(`[spike] ✓ indexed ${itemCount} items`);
