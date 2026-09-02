---
"harnery": minor
---

Report critique tile coverage and refuse a capped signoff. Full-page
critique keeps at most `--check-critique-max-tiles` bands per context
(default 24) and drops the rest, so on a tall page the bottom was never
reviewed and nothing said so. `tilesFromFullPage` now returns
`{ tiles, coverage }`, `browse` records `coverage` (page height, reviewed
height, bands total and reviewed, `capped`) on the critique envelope, and
`qa-run` lifts it onto each critique row. A capped context in signoff mode
is a `critique` blocker and the run finalizes `incomplete`; review mode
keeps the outcome and carries the flag. New `policy.critique_max_tiles`
(1 to 200) reaches the planner and every critique child so the predicted
ceiling and the real coverage agree.
