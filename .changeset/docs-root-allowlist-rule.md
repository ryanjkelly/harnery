---
"harnery": minor
---

docs lint: add opt-in `docs-root-file` rule. Hosts can pass `context.docsRootAllowlist` (a list of filenames permitted loose at the parent repo's `docs/` root); any other `.md`/`.json` there is flagged so topic docs stay in `docs/<topic>/` subdirs. No-op when the allowlist is unset, so standalone `harn` and non-opting consumers are unaffected. Parent-repo only — submodule `docs/` roots keep their own entry tiers.
