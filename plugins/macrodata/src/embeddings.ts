/**
 * Embeddings module using Transformers.js
 *
 * Provides local embedding generation using all-MiniLM-L6-v2
 * No API calls, runs entirely locally
 *
 * Uses dynamic import to avoid slow startup from loading the large
 * @xenova/transformers library at module load time.
 */

import type { FeatureExtractionPipeline } from "@xenova/transformers";

// Singleton pipeline instance (expensive to create)
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineLoading: Promise<FeatureExtractionPipeline> | null = null;

// Model produces 384-dimensional embeddings
export const EMBEDDING_DIMENSIONS = 384;

/**
 * Get or create the embedding pipeline
 * Uses all-MiniLM-L6-v2 – good balance of quality and speed
 */
async function getEmbeddingPipeline(): Promise<FeatureExtractionPipeline> {
  if (embeddingPipeline) {
    return embeddingPipeline;
  }

  // Prevent multiple concurrent pipeline creations
  if (pipelineLoading) {
    return pipelineLoading;
  }

  pipelineLoading = (async () => {
    const { pipeline } = await import("@xenova/transformers");
    return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      // Use quantized model for faster loading
      quantized: true,
    });
  })();

  try {
    embeddingPipeline = await pipelineLoading;
    console.log("[Embeddings] Model loaded successfully");
    return embeddingPipeline;
  } finally {
    pipelineLoading = null;
  }
}

/**
 * Generate embeddings for a single text
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await getEmbeddingPipeline();

  // Generate embeddings
  const output = await pipe(text, {
    pooling: "mean",
    normalize: true,
  });

  // Convert to regular array
  return Array.from(output.data as Float32Array);
}

/**
 * Generate embeddings for multiple texts (batched)
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const pipe = await getEmbeddingPipeline();

  // Process in batches to avoid memory issues
  const batchSize = 32;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const outputs = await pipe(batch, {
      pooling: "mean",
      normalize: true,
    });

    // Handle batched output
    for (let j = 0; j < batch.length; j++) {
      const start = j * EMBEDDING_DIMENSIONS;
      const end = start + EMBEDDING_DIMENSIONS;
      results.push(Array.from((outputs.data as Float32Array).slice(start, end)));
    }
  }

  return results;
}

/**
 * Preload the model (call during startup to avoid first-query delay)
 */
export async function preloadModel(): Promise<void> {
  await getEmbeddingPipeline();
}
