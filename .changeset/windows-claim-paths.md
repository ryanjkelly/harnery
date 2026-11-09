---
"harnery": patch
---

Claim paths and search work on Windows:

- A failed Edit or Write now releases its claim on Windows. The hook compared the `C:\...` target with the stored repository-relative claim and never matched.
- Without required Git finalization, the claim guard keys a Windows absolute path inside the repository as a forward-slash relative path and skips one outside it. It used to treat any `C:\...` path as repository-relative.
- `agents release-claim`, the shell-mutation hint and the committed-clean check strip the repository root from Windows paths.
- Server attribution and sandbox writable-root containment accept `\` as a Windows path separator.
- `harn grep` and `harn callers` say to install ripgrep on Windows when neither ripgrep nor GNU grep is available, and `harn grep --files` no longer runs Windows `FIND.exe`.
