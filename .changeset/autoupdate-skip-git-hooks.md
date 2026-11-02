---
"harnery": patch
---

Self-update no longer fires from inside a Git hook (`GIT_INDEX_FILE` or `GIT_EXEC_PATH` set). A host command run by a pre-commit or pre-push hook could otherwise start the project's update steps, typically a pull, in the middle of the commit or push, or write update state into a hook's temporary snapshot while the hook deletes it. A project root without `.git`, such as a hook's exported snapshot, never fires one either. `HARNERY_AUTOUPDATE=off` (or `0`) turns it off for a process tree, for tools that run host commands inside their own scratch repository.
