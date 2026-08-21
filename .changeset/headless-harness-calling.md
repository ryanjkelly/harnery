---
"harnery": minor
---

New toolkit export `harnery/lib/headless`: run a one-shot prompt (optionally with images) through a locally installed AI coding harness CLI — Claude Code (`claude -p`), Codex (`codex exec`), or Cursor (`cursor-agent -p`) — and get the reply back as text. Promoted from host CLIs that had each grown their own copy for vision-critique providers.

The API is `runHeadless(request, options?)` (walk the backend chain), `runHeadlessOn(name, request)` (exactly one backend), `availableHeadlessBackends()`, and `whichBin()`. Baked-in lessons from production use: every call runs from a neutral temp cwd so the nested session loads no repo instructions or hooks; the child's stdin is closed immediately (an open pipe deadlocks codex); an empty reply throws so gating callers fail closed; and the chain falls back **per call** — a backend that is installed but errors (rate limit, timeout, transient exec failure) hands the same request to the next backend instead of failing the call. `HARNERY_HEADLESS_BACKEND` forces one backend; `HARNERY_HEADLESS_MODEL` overrides the model.
