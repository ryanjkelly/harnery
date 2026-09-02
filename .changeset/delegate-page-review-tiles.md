---
"harnery": patch
---

Require page-review-pack instructions to delegate every primary-tile image read
to review subagents. The coordinating agent assigns tiles, serializes the
reports, and makes the final judgment without opening tile images itself.

Add `harn review-pack reviews add` and v2 findings/verdict contracts so a
verdict remains incomplete until completed subagent records cover every
primary tile in the inspection plan.
