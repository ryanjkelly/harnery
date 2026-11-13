---
"harnery": patch
---

Journal writers (`harn journal add`, `harn agents ping`, dashboard entry edits) now migrate retired zone-abbreviation timestamps in the file they are about to rewrite, saving the original under `.harnery/journal/.migration-backup/`, instead of refusing with "timestamp line(s) this version cannot read". This covers a journal written by an older release before Harnery updated mid-session, and harnesses whose session start does not run the journal janitor. A writer still refuses a line the migration cannot convert.
