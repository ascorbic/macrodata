---
"@macrodata/opencode": minor
---

Add optional remote embedding provider. Configure an OpenAI-compatible embeddings endpoint in `~/.config/macrodata/config.json` to offload embedding generation to an API instead of running the local Transformers.js model:

```json
{
  "embedding": {
    "provider": "openai-compatible",
    "endpoint": "https://api.example.com/v1",
    "api_key": "sk-...",
    "model": "baai/bge-m3",
    "input_type": "passage",
    "query_input_type": "query"
  }
}
```

When configured, the local model is never loaded (no model download, no inference CPU). Without the `embedding` block, behavior is unchanged: local all-MiniLM-L6-v2, fully offline. Switching providers with a different embedding dimension requires rebuilding existing indexes.
