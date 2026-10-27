---
"harnery": patch
---

Run the source CLI and adapter hooks on native Windows without Bash. Add Node launchers, support Windows process creation tokens, handle unsupported directory fsync separately from mandatory file flushes, and interpret state permissions through the platform's inherited ACLs. Keep POSIX permission and directory flush checks on Unix. Start the dashboard without shell-specific port expansion, launch its semantic reader through the active runtime, hide background subprocess windows, and build with native filesystem paths and cleanup.
