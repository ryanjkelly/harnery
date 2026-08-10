---
"harnery": patch
---

`browse --check-clip`: stop reporting scrolled-out content as clipped

The clip rule treated `overflow: auto` and `overflow: scroll` exactly like
`hidden`, so anything a reader could reach by scrolling counted as a layout
defect. A table with a `max-height`, a code block wider than its column, any
capped scroll region — each reported one issue per row or line, and the fix the
report implied (remove the cap) was the opposite of the intent.

An axis now stops being checked at the first ancestor that scrolls it, including
the queried container itself. Constraints from ancestors *inside* that scroller
still apply, so an `overflow: hidden` box nested in a scroller is still reported:
scrolling the outer container cannot reveal what the inner box cut off.

Text handling follows the same rule instead of its previous special case, which
skipped a text node entirely when its nearest block owner scrolled horizontally.
Such text is now still checked vertically, where a real clip can hide it.

Content inside a collapsed `<details>` no longer counts either. Chromium hides it
through the `::details-content` pseudo, which is not in the ancestor chain, so no
computed style on a real ancestor reported it and every closed accordion panel
read as text clipped out of its container.

Both classes were previously masked on busy pages: the check caps at 100 issues,
and a single capped table could fill it, so a real finding further down the
document never got recorded.
