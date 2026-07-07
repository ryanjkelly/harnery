---
"harnery": minor
---

`harn init` now ships the agent-facing layer, not just hooks. It splices a machine-owned, hash-versioned instructions block into `AGENTS.md` and writes the generic `harn-decide` + `harn-council` skills (claude-code), so a fresh consumer's agent knows the decision docket and councils exist. `harn deinit` removes both (a hand-edited skill is left with a warning, never clobbered), and `harn init --check` reports drift without writing (exit 0 fresh / 2 drift / 1 error) for pre-commit / CI. A `CLAUDE.md` `@AGENTS.md` import shim is created when `CLAUDE.md` is absent; one that already reaches `AGENTS.md` is left alone. Suppress a shipped skill you replace with your own via `skills.exclude` in `.harnery/config.jsonc`; the injected block is exclusion-aware, so it points at `<bin> decision --help` / `<bin> council --help` instead of a skill it didn't write (also true for cursor/codex, which get the block but no skill files). Design: ADR 0008.
