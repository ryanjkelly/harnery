---
"harnery": patch
---

`harn docs` works on native Windows. Its metadata sync, lint, link check, index and sweep ran Git through `sh -c`, which a Windows host without a POSIX shell on its PATH cannot start; they now run Git directly. Lint, metadata audit and sweep report repository paths with forward slashes on every OS, so their results match Git's paths (the sweep previously missed file ages on Windows). `harn env` lists Docker containers without a shell too.
