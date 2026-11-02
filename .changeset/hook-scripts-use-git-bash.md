---
"harnery": patch
---

Hook sound and session-sync scripts now run on Windows. Harnery used to start them with whatever `bash` came first on PATH, which on Windows is often the WSL launcher: it cannot open a Windows script path, and it fails when no Linux distribution is installed. Harnery now finds Git for Windows' bash (through `git --exec-path`, the standard install folders, or PATH) and never uses the WSL launcher. Set `HARNERY_BASH_PATH` to choose a specific bash. When no usable bash exists, these optional scripts are skipped quietly.
