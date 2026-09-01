---
"harnery": minor
---

Export the admission toolkit so host CLIs can join the same machine-wide
queues as `qa-run` and `admission run`. `harnery/lib/admission` now ships
`acquireAdmission`, `admissionStatus`, and `admissionBaseDir` (the shared
`$TMPDIR/harnery-admission` / `HARNERY_ADMISSION_DIR` helper). Command
modules keep using that helper; they no longer own the path formula.
