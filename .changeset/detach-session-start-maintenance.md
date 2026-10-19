---
"harnery": patch
---

Session start no longer waits for storage maintenance. The journal and image janitors, the artifact sweep, V3 archive cleanup and the automatic maintenance pass now run in a detached worker, so an adapter that stops a slow hook still receives the session context. Artifact inventory sizes each workspace and finds its newest change in one walk instead of two. The cleanup time budget now covers deletions rather than the inventory that precedes them, so a slice can delete more than one entry. A sweep that deleted nothing waits a full interval before retrying instead of one minute.