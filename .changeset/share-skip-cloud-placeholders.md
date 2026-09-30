---
"harnery": patch
---

`claude-desktop share` no longer hangs or aborts on a synced-folder file whose contents have not downloaded yet: such sessions are skipped as `not-downloaded`, a download is requested, and the next pass imports them. A session that still fails to copy is listed under `failed` while the rest of the pass completes.
