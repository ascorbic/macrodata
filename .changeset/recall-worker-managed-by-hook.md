---
"macrodata": patch
---

Manage the ambient-recall worker from `macrodata-hook.sh`, on both hook events, so a
plugin update takes effect without waiting for a new session. The worker had its own
SessionStart-only supervisor, and SessionStart does not fire on `/plugin update` +
`/reload-plugins` — so the pass that reaps the previous version's worker only ran once
a session happened to open, and until then a freshly installed release kept serving
recall from the old cached code. The daemon already converged on every prompt; the
worker now does too, through the same verified-kill path. Per-prompt passes stay silent
unless they act, so neither the model's context nor the log gets a line per message.

Converging on every prompt also means concurrent sessions can observe the same
worker-less window and spawn into it together, so the worker now claims
`.recall/worker.pid` before it can load a model and stands down if another process
already serves that state root. A claim whose process is gone is taken over rather
than obeyed — the hook stops a stale-version worker with SIGKILL, which never gets to
clean up after itself. A reboot restarts the PID space from the bottom, where a
surviving claim can name an unrelated live process and mute recall for good, so the
hook reads the holder's own command line and clears the claim unless that process is
itself a worker.
