---
"harnery": patch
---

The artifact sweep now asks Git which files are tracked once per pass instead of once per workspace. On a host where each `git ls-files` takes seconds, the old check held the artifact store lock for about a minute at session start. The listing now runs before the lock is taken, and one fresh listing under the lock still guards the deletions, so a file Git starts tracking mid-sweep keeps its workspace. If Git cannot answer, nothing is deleted, as before. A throttled sweep starts no Git process at all.

When two session workers start together and one finds the other holding the store lock, `autoCleanArtifacts` now returns `reason: "busy"` instead of throwing, so the expected overlap no longer logs an error or marks the hook degraded. A lock whose owner cannot be verified as the same live process (an empty or invalid lock, another host, or a reused process id) still throws.

Three tests now pass on Windows: the backup schedule test accepts native path separators, the sparse-file size test expects full-length counting because NTFS allocates an extended file in full, and the failed-deletion sweep test holds the directory open as the working directory, since Windows ignores a directory's write bit.
