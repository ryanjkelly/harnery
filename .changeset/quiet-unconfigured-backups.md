---
"harnery": patch
---

Skip scheduled backups quietly when this machine lacks restic, the password file, rclone, or the configured rclone remote. Manual snapshots report each missing prerequisite. Machines with local setup still retry failed scheduled runs and show their failure cue.
