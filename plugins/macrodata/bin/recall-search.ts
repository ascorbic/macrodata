/**
 * CLI: ad-hoc query against the ambient-recall index — for eyeballing retrieval
 * quality without waiting for a hook to fire.
 *   bun run bin/recall-search.ts "what is porrima"
 *   bun run bin/recall-search.ts "ambient memory" 8
 */

import { searchMemory } from "../src/recall/indexer.ts";

const query = process.argv[2];
const limit = process.argv[3] ? Number(process.argv[3]) : 5;

if (!query) {
  console.error('usage: bun run bin/recall-search.ts "<query>" [limit]');
  process.exit(1);
}

const t0 = Date.now();
const results = await searchMemory(query, { limit });
const ms = Date.now() - t0;

console.log(`\nquery: ${query}   (${results.length} hits, ${ms}ms)\n`);
for (const r of results) {
  const where = r.section ? `${r.source} › ${r.section}` : r.source;
  const snippet = r.content.replace(/\s+/g, " ").slice(0, 140);
  console.log(`  [${r.score.toFixed(3)}] ${r.type}  ${where}`);
  console.log(`         ${snippet}\n`);
}
