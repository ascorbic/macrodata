# Macrodata

Cloud memory MCP server for coding agents. Built on Cloudflare Workers with Vectorize for semantic search.

## Features

- **Semantic Memory** - Store and search memories with vector embeddings
- **Journal** - Append-only log for observations and decisions
- **Conversation Summaries** - Persist session context across conversations
- **Scheduled Tasks** - Cron and one-shot reminders via Durable Objects
- **Web Search** - Brave Search integration
- **Multi-model Support** - AI Gateway for external models, Workers AI for local

## Setup

```bash
pnpm install
cp .dev.vars.example .dev.vars
# Fill in your secrets in .dev.vars
pnpm dev
```

## Configuration

Edit `macrodata.config.ts` to configure models:

```typescript
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
  },
});
```

## Deployment

```bash
# Set secrets
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
# ... other secrets from .dev.vars.example

# Deploy
pnpm deploy
```

## License

MIT
