---
"@macrodata/opencode": patch
---

Retry a scheduled `claude --print` run once when it exits on the subscription's session limit. Claude Code prints `You've hit your session limit · resets 2:30am (Europe/London)` and exits 1 within a couple of seconds; the daemon now reads the reset time from that line and re-fires the same schedule one minute after it, once per fire. Previously the run was simply lost and the log showed only `child exited (code=1)`.
