---
"harnery": patch
---

Preserve rolling artifact expiry across manifest migrations, release, and hold
updates. Payload edits, renames, and deletions still extend retention. Add a
preview-first activity repair for unchanged older migrations with verified
preimages, preserving explicit retention windows and recording correction receipts.
