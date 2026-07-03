---
"harnery": patch
---

Claim guard: re-editing a file you already hold no longer trips the ordering rule

The ordering check blocked acquiring path B while holding a higher-sorting
uncommitted path A — even when B was already in your own `files_touched`.
Re-editing a claim you already hold acquires no new lock edge, so it cannot
create a circular wait; the ordering rule must not block it. This was the
dominant source of spurious `claim.ordering_violation` friction under
concurrency: an agent doing multiple edit passes over a set of files it had
already claimed got blocked on the second pass the moment it also touched a
higher-sorting file (e.g. hold `README.md`, then edit `docs/x.md`, then
re-edit the already-held `README.md` → blocked). The ordering guard now
exempts already-held targets; genuinely-new lower acquisitions still block
(the deadlock-prevention invariant is unchanged).
