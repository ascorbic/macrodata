---
"macrodata": patch
---

spike(ambient-recall): structured worker logging via LogTape. The worker now emits NDJSON records with per-line timestamps under subsystem categories (`recall.worker` / `recall.ingest` / `recall.pipeline`), and the previously-silent paths are visible: a pipeline-start line (a never-settling pipeline is now provable from the log instead of inferable from absence), a warning when the short-search guard drops an already-consumed request, and a queued-behind-active-drain line that surfaces the drain-wedge failure mode in real time.
