---
"harnery": patch
---

`harn web up` and `harn web start` now pin a V8 old-space ceiling (2048 MB by default) instead of letting Next size it to roughly half of system RAM.

On a large machine Next's own ceiling is one the dashboard never approaches, so V8 never feels enough pressure to run a major GC and a long-lived server settles at a multi-gigabyte working set of mostly collectable garbage. Tune with `--max-old-space <mb>` or `HARNERY_WEB_MAX_OLD_SPACE`; pass `0` to restore Next's sizing. A ceiling already present in `NODE_OPTIONS` is left untouched.
