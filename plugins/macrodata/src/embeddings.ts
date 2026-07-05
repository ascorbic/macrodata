/**
 * Embeddings module
 *
 * Default: local embedding generation via Transformers.js
 * (all-MiniLM-L6-v2, 384-dim), no API calls, fully offline.
 *
 * Optional: a remote OpenAI-compatible embeddings endpoint configured in
 * ~/.config/macrodata/config.json, which offloads embedding to an API and
 * avoids loading the local model entirely:
 *
 *   {
 *     "embedding": {
 *       "provider": "openai-compatible",
 *       "endpoint": "https://api.example.com/v1",
 *       "api_key": "sk-...",            // or "api_key_env": "MY_KEY_VAR"
 *       "model": "baai/bge-m3",
 *       "input_type": "passage",        // optional, for models that need it
 *       "query_input_type": "query",    // optional
 *       "batch_size": 64,               // optional, default 64
 *       "extra_body": {}                // optional, merged into the request
 *     }
 *   }
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { FeatureExtractionPipeline } from "@huggingface/transformers";

export interface RemoteEmbeddingConfig {
  provider: "openai-compatible";
  endpoint: string;
  api_key?: string;
  api_key_env?: string;
  model: string;
  input_type?: string;
  query_input_type?: string;
  batch_size?: number;
  extra_body?: Record<string, unknown>;
}

// Local model produces 384-dimensional embeddings
export const EMBEDDING_DIMENSIONS = 384;

let cachedRemoteConfig: RemoteEmbeddingConfig | null | undefined;

export function getRemoteEmbeddingConfig(): RemoteEmbeddingConfig | null {
  if (cachedRemoteConfig !== undefined) return cachedRemoteConfig;

  const configPath =
    process.env.MACRODATA_CONFIG_PATH || join(homedir(), ".config", "macrodata", "config.json");

  cachedRemoteConfig = null;
  if (existsSync(configPath)) {
    try {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const embedding = config.embedding;
      if (
        embedding &&
        embedding.provider === "openai-compatible" &&
        typeof embedding.endpoint === "string" &&
        typeof embedding.model === "string"
      ) {
        cachedRemoteConfig = embedding as RemoteEmbeddingConfig;
      }
    } catch (err) {
      console.error(`[Embeddings] Failed to parse config.json, using local model: ${err}`);
    }
  }

  return cachedRemoteConfig;
}

export function resetEmbeddingConfigCache(): void {
  cachedRemoteConfig = undefined;
}

function resolveApiKey(config: RemoteEmbeddingConfig): string | undefined {
  if (config.api_key_env) {
    const fromEnv = process.env[config.api_key_env];
    if (fromEnv) return fromEnv;
  }
  return config.api_key;
}

async function embedRemote(
  texts: string[],
  config: RemoteEmbeddingConfig,
  kind: "passage" | "query"
): Promise<number[][]> {
  const url = `${config.endpoint.replace(/\/$/, "")}/embeddings`;
  const apiKey = resolveApiKey(config);
  const inputType = kind === "query" ? config.query_input_type : config.input_type;

  const body: Record<string, unknown> = {
    ...(config.extra_body ?? {}),
    model: config.model,
    input: texts,
  };
  if (inputType) {
    body.input_type = inputType;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(
      `Remote embedding request failed: ${response.status} ${response.statusText} ${errText.slice(0, 300)}`
    );
  }

  const result = (await response.json()) as {
    data?: { index?: number; embedding: number[] }[];
  };

  if (!result.data || result.data.length !== texts.length) {
    throw new Error(
      `Remote embedding response mismatch: expected ${texts.length} embeddings, got ${result.data?.length ?? 0}`
    );
  }

  // OpenAI-compatible APIs may return out of order; sort by index when present
  const sorted = [...result.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return sorted.map((d) => d.embedding);
}

async function embedRemoteBatched(
  texts: string[],
  config: RemoteEmbeddingConfig,
  kind: "passage" | "query"
): Promise<number[][]> {
  const batchSize = config.batch_size && config.batch_size > 0 ? config.batch_size : 64;
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    results.push(...(await embedRemote(batch, config, kind)));
  }

  return results;
}

// Singleton pipeline instance (expensive to create)
let embeddingPipeline: FeatureExtractionPipeline | null = null;
let pipelineLoading: Promise<FeatureExtractionPipeline> | null = null;

/**
 * Get or create the local embedding pipeline
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
    const { pipeline } = await import("@huggingface/transformers");
    return pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2", {
      // Use quantized model for faster loading
      dtype: "q8",
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

async function embedLocal(texts: string[]): Promise<number[][]> {
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

    const dims = (outputs.dims?.at(-1) as number) || EMBEDDING_DIMENSIONS;
    for (let j = 0; j < batch.length; j++) {
      const start = j * dims;
      const end = start + dims;
      results.push(Array.from((outputs.data as Float32Array).slice(start, end)));
    }
  }

  return results;
}

/**
 * Generate an embedding for a single text (indexed content)
 */
export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedBatch([text]);
  return vector;
}

/**
 * Generate an embedding for a search query.
 * Remote providers may use a different input_type for queries (e.g. BGE-M3).
 */
export async function embedQuery(text: string): Promise<number[]> {
  const remote = getRemoteEmbeddingConfig();
  if (remote) {
    const [vector] = await embedRemoteBatched([text], remote, "query");
    return vector;
  }
  const [vector] = await embedLocal([text]);
  return vector;
}

/**
 * Generate embeddings for multiple texts (batched, indexed content)
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const remote = getRemoteEmbeddingConfig();
  if (remote) {
    return embedRemoteBatched(texts, remote, "passage");
  }
  return embedLocal(texts);
}

/**
 * Preload the model (call during startup to avoid first-query delay).
 * No-op when a remote embedding provider is configured.
 */
export async function preloadModel(): Promise<void> {
  if (getRemoteEmbeddingConfig()) {
    console.log("[Embeddings] Remote embedding provider configured, skipping local model load");
    return;
  }
  await getEmbeddingPipeline();
}
