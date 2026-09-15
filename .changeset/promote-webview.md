---
"harnery": minor
---

Add `webview`, a lightweight headless page probe through `Bun.WebView` (experimental, Bun 1.4+), as a Harnery command. It starts a fresh browser per call with ephemeral storage unless `--profile` is given, never attaches to a running user browser, scrolls before clicking, waits for same-URL replacement documents after actions, and takes the human-pace gate with `--no-pace`. On Node it fails with a clear `webview_unavailable` message, like `tunnel`. Embedding hosts that carried their own copy can delete it and take the command from `createHarneryProgram`. ADR 0185.
