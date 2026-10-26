---
"harnery": patch
---

`docs metadata sync --check` now rejects lifecycle timestamps later than the current time (with a 10-minute allowance for clock skew). When a committed `status_changed_at` is already in the future, sync accepts a correction to a time that has passed instead of pinning the impossible value until the clock catches up.
