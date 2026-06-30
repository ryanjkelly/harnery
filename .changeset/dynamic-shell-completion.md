---
"harnery": minor
---

completion: add dynamic (install-once) shell completion via `--dynamic`. The new shim is tree-independent — it asks the live binary for candidates on every `<Tab>` through a hidden `__complete-line` entry point, so it never goes stale when commands or flags change (no regeneration/reinstall needed). `completion bash|zsh|fish --dynamic` emit the shim; `completion install --dynamic` installs it. Static generation and the legacy `__complete <provider>` callback are unchanged, so existing installed scripts keep working. A shared `resolveCompletions()` resolver (one place, all three shells) computes subcommand / option / enum / dynamic-provider candidates plus a Cobra-style directive for file fallback.
