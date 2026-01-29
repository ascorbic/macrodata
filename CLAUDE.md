# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build and Development Commands

```bash
pnpm dev            # Start local dev server with wrangler
pnpm deploy         # Deploy to Cloudflare Workers
pnpm types          # Regenerate worker-configuration.d.ts
pnpm check          # Type check with tsc
pnpm lint           # Run oxlint
pnpm lint:fix       # Run oxlint with auto-fix
pnpm format         # Format with oxfmt
pnpm test           # Run tests
```

## Architecture

Macrodata is a cloud memory MCP server for coding agents, built on Cloudflare Workers.

**Entry point**: `src/index.ts` - Hono app wrapped with OAuth provider

**Configuration**: `macrodata.config.ts` - User-editable config for models, embedding, OAuth

**Core modules**:

- `src/config.ts` - Type definitions and `defineConfig` helper
- `src/models.ts` - AI SDK provider setup, reads from config
- `src/mcp-agent.ts` - Durable Object implementing MCP tools
- `src/types.ts` - Env type augmentation for OAUTH_PROVIDER
- `src/web-search.ts` - Brave search integration
- `src/web-fetch.ts` - URL fetching as markdown

**Key bindings** (in wrangler.jsonc):

- `AI` - Workers AI for embeddings and local models
- `VECTORIZE` - Vector index for semantic search
- `MCP_OBJECT` - Durable Object for per-user state
- `OAUTH_KV` - KV namespace for OAuth tokens

**Secrets** (in .dev.vars for local, `wrangler secret put` for prod):

- OAuth credentials (Google/GitHub)
- API keys (Brave, CF API token)

## Model Configuration

Models are configured in `macrodata.config.ts`:

- `models.fast` - Quick tasks (default: Gemini Flash via AI Gateway)
- `models.thinking` - Deep reasoning (default: Claude Opus via AI Gateway)
- `models.local` - Free Workers AI model (default: Kimi K2)
- `embedding` - Vectorize embedding model (BGE variants)

External models route through AI Gateway's unified provider. Local models use Workers AI directly.
