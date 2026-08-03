---
"harnery": minor
---

Add four content checks to `browse`: placeholder, image, truncation, contrast.

The layout checks cover rendered geometry, but a page can be geometrically perfect and still ship a bug a human catches at a glance: a leaked template token, a broken image, a clipped label, unreadable text. These four checks close that gap so an agent can verify its own output without a person eyeballing a screenshot. Each runs in one page evaluation, lands in the JSON envelope, annotates the screenshot, and gates the exit code with its `-fail` flag.

- `--check-placeholder [selector]` flags unrendered tells in the visible text: `{{x}}` and JS template tokens, `[object Object]`, `Invalid Date`, `NaN`, or an element whose whole text is literally "undefined" or "null". Bare "undefined"/"null" only flag when they are an element's entire text, so the word in ordinary prose does not trip it.
- `--check-images [selector]` audits `<img>` for a failed load (naturalWidth 0), a still-loading image, or a stretched one (rendered aspect ratio far from the intrinsic ratio, with an object-fit that does not correct it). `--check-images-tolerance` sets the aspect deviation (default 0.1).
- `--check-truncation [selector]` flags text actively cut off by an ellipsis or a `-webkit-line-clamp` — the author asked to truncate and the content overflows. It stays quiet on plain `overflow: hidden` clips, which are usually intentional. `--check-truncation-tolerance` sets the overflow slack in px (default 2).
- `--check-contrast [selector]` flags rendered text below the WCAG AA ratio (4.5:1 normal, 3:1 large) against its effective background, resolved by walking ancestors to the first opaque color. Text over an image or gradient is reported as `unknown`, not failed. It runs at whatever theme the page is in, so toggle the theme with `--batch` to cover light and dark.

Each check takes an optional selector (default: the whole body), adds `--check-<name>-fail` and `--no-check-<name>-annotate`, and reports per-hit rects, labels, and snippets.
