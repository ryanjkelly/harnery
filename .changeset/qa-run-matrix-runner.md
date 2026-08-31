---
"harnery": minor
---

Add `qa-run`, a one-command page-QA matrix runner: it executes the QA planner, deterministic gates per viewport/theme/state through a bounded process pool, interaction assertions, manifest-required critique, and the QA snapshot in a single invocation, writing one fail-closed machine-readable result. Jobs are validated (secret-bearing fields refused) and may widen but never narrow the planner's coverage.
