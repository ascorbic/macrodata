/**
 * Model providers for Macrodata
 *
 * Reads configuration from macrodata.config.ts and creates AI SDK providers.
 */

import { createAiGateway } from "ai-gateway-provider";
import { createUnified } from "ai-gateway-provider/providers/unified";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";
import type { CoreModelTier, EmbeddingModel } from "./config";
import config from "../macrodata.config";

// Re-export types
export type { CoreModelTier, EmbeddingModel };

// Export config values for use elsewhere
export const models = config.models;
export const embeddingModel: EmbeddingModel = config.embedding;

/** Model tiers available in current config */
export type ModelTier = keyof typeof config.models;

interface ModelEnv {
  AI: Ai;
  CF_ACCOUNT_ID?: string;
  CF_AIG_GATEWAY_ID?: string;
  CF_API_TOKEN?: string;
}

/**
 * Create a language model for the given tier
 */
export function createModel(
  env: ModelEnv,
  tier: string = "fast",
): LanguageModel {
  const modelId =
    (config.models as Record<string, string>)[tier] ?? config.models.fast;
  const isLocal = modelId.startsWith("@cf/") || modelId.startsWith("@hf/");

  // Local models use Workers AI directly
  if (isLocal) {
    const workersAI = createWorkersAI({ binding: env.AI });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return workersAI(modelId as any);
  }

  // External models go through AI Gateway
  if (!env.CF_ACCOUNT_ID || !env.CF_AIG_GATEWAY_ID || !env.CF_API_TOKEN) {
    console.warn("[models] AI Gateway not configured, using local fallback");
    const workersAI = createWorkersAI({ binding: env.AI });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return workersAI(config.models.local as any);
  }

  const gateway = createAiGateway({
    accountId: env.CF_ACCOUNT_ID,
    gateway: env.CF_AIG_GATEWAY_ID,
    apiKey: env.CF_API_TOKEN,
  });

  const unified = createUnified();
  return gateway(unified(modelId));
}

/**
 * Format model tiers for tool descriptions
 */
export function formatModelOptions(): string {
  return Object.entries(config.models)
    .map(([tier, id]) => `- "${tier}": ${id}`)
    .join("\n");
}
