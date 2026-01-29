import { env } from "cloudflare:workers";
import { defineConfig } from "./src/config";

export default defineConfig({
  models: {
    fast: "google-ai-studio/gemini-2.5-flash",
    thinking: "anthropic/claude-opus-4-20250514",
    local: "@cf/moonshotai/kimi-k2-instruct",
  },

  embedding: "@cf/baai/bge-base-en-v1.5",

  oauth: {
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    },
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
  },
});
