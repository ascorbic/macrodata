/**
 * Cross-encoder reranker.
 *
 * Vectra returns bi-encoder candidates by pooled cosine similarity.
 * This module rescores (query, candidate) pairs with a cross-encoder
 * (Xenova/ms-marco-MiniLM-L-6-v2) so the final ordering reflects
 * cross-attention semantics — approximating late-interaction precision
 * without swapping the index format.
 *
 * Cost: ~150-300ms for ~20 candidates on first call after model load.
 *
 * Singleton pattern matches getEmbeddingPipeline() in embeddings.ts.
 */

import { getLogger } from "@logtape/logtape";

const MODEL_ID = "Xenova/ms-marco-MiniLM-L-6-v2";

// Sink comes from the entrypoint's configure(); unconfigured processes (hooks,
// tests) drop the records instead of leaking model chatter onto stdout.
const logger = getLogger(["macrodata", "rerank"]);

type AnyTokenizer = (
  texts: string[],
  options: { text_pair: string[]; padding: boolean; truncation: boolean },
) => unknown;

type AnyModel = (features: unknown) => Promise<{ logits: { data: Float32Array } }>;

let crossEncoderModel: AnyModel | null = null;
let crossEncoderTokenizer: AnyTokenizer | null = null;
let loading: Promise<void> | null = null;

async function loadCrossEncoder(): Promise<void> {
  if (crossEncoderModel && crossEncoderTokenizer) return;
  if (loading) return loading;

  loading = (async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import(
      "@huggingface/transformers"
    );
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(MODEL_ID),
      AutoModelForSequenceClassification.from_pretrained(MODEL_ID, { dtype: "q8" }),
    ]);
    crossEncoderTokenizer = tokenizer as unknown as AnyTokenizer;
    crossEncoderModel = model as unknown as AnyModel;
    logger.info("cross-encoder loaded");
  })();

  try {
    await loading;
  } finally {
    loading = null;
  }
}

/**
 * Score (query, doc) pairs with the cross-encoder.
 * Returns one float per doc (higher = more relevant).
 *
 * Raw logits are unbounded; we apply sigmoid to get [0, 1] scores
 * so they're roughly drop-in compatible with the existing cosine
 * floors. Order is preserved either way.
 */
export async function rerank(query: string, docs: string[]): Promise<number[]> {
  if (docs.length === 0) return [];

  await loadCrossEncoder();
  if (!crossEncoderModel || !crossEncoderTokenizer) {
    throw new Error("Cross-encoder failed to load");
  }

  const queries = Array(docs.length).fill(query);
  const features = crossEncoderTokenizer(queries, {
    text_pair: docs,
    padding: true,
    truncation: true,
  });

  const { logits } = await crossEncoderModel(features);
  return Array.from(logits.data).map((x) => 1 / (1 + Math.exp(-x)));
}

export async function preloadRerankModel(): Promise<void> {
  await loadCrossEncoder();
}
