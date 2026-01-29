import { describe, it, expect } from "vitest";
import { defineConfig } from "../src/config.ts";

describe("defineConfig", () => {
  it("returns the config unchanged", () => {
    const config = defineConfig({
      models: {
        fast: "google-ai-studio/gemini-2.5-flash",
        thinking: "anthropic/claude-opus-4-20250514",
        local: "@cf/moonshotai/kimi-k2-instruct",
      },
      embedding: "@cf/baai/bge-base-en-v1.5",
    });

    expect(config.models.fast).toBe("google-ai-studio/gemini-2.5-flash");
    expect(config.embedding).toBe("@cf/baai/bge-base-en-v1.5");
  });
});
