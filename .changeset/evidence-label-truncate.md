---
"harnery": patch
---

Truncate an over-long workflow evidence label instead of failing the run.

`evidence()` is called at the END of a stage, so throwing on an over-long label discards everything the run produced. A completed three-agent review was lost this way because its label ran 31 characters past the 200-char bound.

The label is a display string; the substance lives in `summary` and `ref`. It is now shortened with a visible `…[truncated]` marker, matching the posture the transcript writer already takes when it shrinks an oversized record. A missing or blank label still throws, since that is a caller bug rather than an overflow.
