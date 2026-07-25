---
"harnery": minor
---

Add `browse --capture-evaluate <js>` for trio mode: evaluate JavaScript inside the
exact viewport used for the screenshot, immediately before capture, and write the
result alongside it as `captureEval`. Full-page capture now converges its
evaluation viewport under explicit pass, dimension, and pixel limits, records the
final document and PNG dimensions, reports nonconvergence rather than emitting
mismatched evidence, and restores the original viewport on every exit path.
