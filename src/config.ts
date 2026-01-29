/**
 * Configuration types for Macrodata
 */

// ==========================================
// Type Helpers
// ==========================================

/** Extract keys from T where the value extends V */
export type KeysWithValue<T, V> = {
  [K in keyof T]: T[K] extends V ? K : never;
}[keyof T];

// ==========================================
// Model Types (derived from AiModels)
// ==========================================

/** Models typed with the base classes (older models) */
type BaseTypedTextGen = KeysWithValue<AiModels, BaseAiTextGeneration>;
type BaseTypedEmbedding = KeysWithValue<AiModels, BaseAiTextEmbeddings>;

/** Models with specific classes (newer models) - match by naming convention */
type SpecificTextGen = Extract<
  keyof AiModels,
  | `@cf/meta/llama-${string}`
  | `@cf/qwen/${string}`
  | `@cf/moonshotai/${string}`
  | `@cf/deepseek-ai/${string}`
>;
type SpecificEmbedding = Extract<keyof AiModels, `@cf/baai/bge-${string}`>;

/** Text generation models on Workers AI */
export type TextGenerationModel = BaseTypedTextGen | SpecificTextGen;

/** Embedding models on Workers AI */
export type EmbeddingModel = BaseTypedEmbedding | SpecificEmbedding;

/** Local model (runs on Workers AI) */
export type LocalModel = TextGenerationModel;

/** External model (via AI Gateway) - provider/model format */
export type ExternalModel = `${string}/${string}`;

/** Any model identifier */
export type ModelId = LocalModel | ExternalModel;

// ==========================================
// Config Types
// ==========================================

/** Core model tiers that are always available */
export type CoreModelTier = "fast" | "thinking" | "local";

import type { Google, GitHub } from "arctic";

/** Supported OAuth identity providers */
export type OAuthProvider = Google | GitHub;

/** OAuth provider credentials */
export interface OAuthCredentials {
  clientId: string | undefined;
  clientSecret: string | undefined;
}

export interface MacrodataConfig<
  Tiers extends string = CoreModelTier,
  E extends EmbeddingModel = EmbeddingModel,
> {
  /** Model IDs by tier */
  models: Record<Tiers | CoreModelTier, ModelId>;

  /** Embedding model for vectorize */
  embedding: E;

  /** OAuth provider credentials (env var names for clientId/clientSecret) */
  oauth?: {
    google?: OAuthCredentials;
    github?: OAuthCredentials;
  };
}

// ==========================================
// Helper
// ==========================================

/**
 * Define your Macrodata configuration with full type safety
 */
export function defineConfig<Tiers extends string, E extends EmbeddingModel>(
  config: MacrodataConfig<Tiers, E>,
): MacrodataConfig<Tiers, E> {
  return config;
}
