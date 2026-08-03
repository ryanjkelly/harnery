---
"harnery": minor
---

Rename the `./core/supervisor` export subpaths to `./core/governor`.

Renaming the supervisor to the governor moved `src/core/supervisor/` to
`src/core/governor/` and renamed every symbol in it, but three export subpaths kept
the old name and the old path: `./core/supervisor`, `./core/supervisor/state`, and
`./core/supervisor/plans`. All three resolved to files that no longer exist, so on a
fresh build any import of `harnery/core/supervisor` failed outright, and the
`Supervisor*` symbols those subpaths advertised were already gone.

They are now `./core/governor`, `./core/governor/state`, and
`./core/governor/plans`, pointing at the governor module and exporting `Governor*`.
A consumer importing the old subpath updates the specifier and the symbol names
together; nothing that worked before stops working, because the old subpath could
not resolve.

A `tsc` rebuild does not delete output for a source file that moved, so the stale
`dist/core/supervisor/` left behind by the rename kept satisfying the built path on
the machine that made it. Two guards close that gap: a unit test asserts every
export subpath's source target exists, and the published-package smoke test builds
from clean and imports the renamed subpath on Node.
