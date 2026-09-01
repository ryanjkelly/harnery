---
"harnery": minor
---

Run any heavy command as a durable detached job. `admission run --detach` hands
the command to a supervisor that queues for its slot, runs it with output on
disk, and records the terminal exit code, so losing the client no longer loses
the job. `admission wait <job-dir>` reconnects and returns the command's own
exit code, `admission jobs` lists recent jobs with their state, and
`admission status` reports detached jobs in flight beside queue holders. A
supervisor that dies is classified dead rather than left ambiguous, which is
what lets a caller retry safely instead of guessing.
