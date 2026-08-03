---
"harnery": minor
---

Add `browse --check-crowd`: flag adjacent card panels that touch.

A page full of callouts stacked flush against each other had no gate to catch it. `--check-overlap` needs a real 2D intersection, and `--check-gap` flags *uneven* spacing, so a uniformly-flush stack of cards passes both. Nothing measured "these two distinct panels have no breathing room between them," the single most common standalone-page layout bug.

`--check-crowd <selector>` fills that hole. It walks the whole subtree under the selector, finds card-like panels (a full border box, a modest corner radius, or a box-shadow), and flags any adjacent same-parent pair separated by less than `--check-crowd-min` CSS px (default 6; negative separation always flags). One `--check-crowd .wrap` catches nested cases like callouts inside an accordion body.

The panel test is deliberately narrow so it does not fire on things that are flush by design. Table cells, list and definition rows, and divided segments (a background-only cell in a `gap:1px` strip) carry no card boundary of their own and are skipped. Pills, chips, and badges (corner radius at least half their shorter side) are inline controls, not layout cards, and are skipped too.

Results land in the JSON envelope under `crowd` (per pair: the two panels, the edge `separationPx`, the `axis`, and the shared `parentLabel`), annotate the screenshot with a teal seam along the touching edge, and gate the exit code with `--check-crowd-fail`.
