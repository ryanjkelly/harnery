---
"harnery": minor
---

The scratchpad is now the journal, and the run record is now the transcript.

`harn scratch` becomes `harn journal`. The command's own help had been calling it a journal for as long as it has existed, because that is what it is: dated entries an agent writes about its own work, in categories like note, plan, decision, and blocker. `scratch` promised something disposable and the feature is the opposite — it is the one thing that survives context compaction, and peers read it on purpose. The state directory moves from `.harnery/scratch/` to `.harnery/journal/`, the `./core/scratch` export subpath becomes `./core/journal`, and the dashboard panel follows.

Taking that word meant giving up another use of it. A workflow run wrote its append-only record to `journal.jsonl`, sha256-hashed into the run proof, and one word covering both a hand-written notebook and a machine-written integrity record is exactly the collision this rename set out to remove. The run record becomes `transcript.jsonl`, which is the better name on its own merits: its parent directory was already called the transcript directory, and a transcript is precisely the record of what an execution said and did.

Two breaking shapes for anyone reading state directly. Runtime state under `.harnery/` is untracked, so an existing checkout renames `.harnery/scratch/` by hand or starts fresh. And the run proof's integrity block now reports `transcript` where it reported `journal`, with the file at `transcript.jsonl`; a stored proof from an earlier version will not match a re-derivation.
