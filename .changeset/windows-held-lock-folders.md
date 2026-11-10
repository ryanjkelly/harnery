---
"harnery": patch
---

On Windows, the journal lock, the desktop grant and lease locks, the backup snapshot lock and the auto-update run lock now treat a lock folder that is being removed as held. Windows reports `EPERM` when a process creates a lock folder while another process is deleting it; these locks used to fail on that error and now wait (journal, grant and lease) or report busy (backup and auto-update), exactly as they do for an existing lock. Deadlines, stale-lock handling and error messages are unchanged, and other platforms still treat `EPERM` as a real permission error. The grant lock's wait now also stops at its usual deadline when its lock folder keeps disappearing. The rule lives in one shared helper that the page review snapshot store uses too.
