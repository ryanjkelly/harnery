---
"harnery": minor
---

`admission run` reads per-resource defaults (capacity, timeout, memory-pressure deferral) from `.harnery/config.jsonc` `admission.resources`, runs nested calls on a held resource directly through `HARNERY_ADMISSION_HELD`, honors `HARNERY_ADMISSION_SKIP=1`, and defaults its queue to `/tmp/harnery-admission` on POSIX so sessions with a private `TMPDIR` share one queue.
