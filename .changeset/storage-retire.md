---
"harnery": minor
---

Add `harn storage retire [name]`, which removes the record folders that removed features left in `.harnery` (ADR 0239). Without a name it lists the retired folders, whether each exists, and its file and byte counts. With a name it previews the counts and an inventory digest and changes nothing; `--yes --inventory-sha256 <digest>` deletes the folder after checking that nothing changed. Only the listed folders (`work`, `governors`, `governor-service`, `councils` and `mailbox`) are eligible, and retirement never runs automatically. `harn rm` no longer suggests `--allow-protected` for the live workspace's own `.git` or `.harnery`, which it can never accept.
