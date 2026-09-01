---
"harnery": minor
---

qa-run results are now verifiable evidence, and qa-verify checks them. Result
schema v2 gives every invocation a run identity block (run_id, start/finish
timestamps, tested revision with source and dirty-worktree flag, a SHA-256
digest of the effective job, and the recorded output directory), host-pressure
samples, and last_completed_stage. Output is isolated per run: --out-dir names
a parent and each invocation writes into run-<run_id>/ beneath it, maintaining
an atomically-renamed latest.json pointer, so a reused workspace can never
present a stale result as current. The new qa-verify command resolves a result
file, run directory, or parent (via latest.json), matches the identity block
against expectations (--run-id, --revision, --job digest reconstruction,
--max-age, and always the moved-result rule), and exits 0 fresh / 3 stale or
unverifiable / 1 on usage or invalid-job errors. Alpha cutover: no v1
compatibility reader.
