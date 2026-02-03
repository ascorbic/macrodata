---
"@macrodata/opencode": patch
---

Add daemon hot-reload support and cleanup

- Daemon now supports SIGHUP to reload config without restart
- Daemon logs to file instead of console
- Hook and OpenCode plugin signal daemon reload on session start
- Context now lists actual state/entity files instead of just paths
- Dynamic import of transformers library for faster startup
- Remove redundant readStateFile and indexFile tools
