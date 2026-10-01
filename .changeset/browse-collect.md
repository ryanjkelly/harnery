---
"harnery": minor
---

Add `browse --collect [preset]`, a scroll-and-collect mode for infinite feeds. Virtualized lists keep only on-screen items in the DOM, so collect mode scrolls in reader-like steps (mouse-wheel notches, randomized step sizes and pauses, occasional reading pauses and small scroll-backs, all seedable with `--collect-seed`), harvests every item after each scroll and during each pause, de-duplicates by key in first-seen order, and stops on `--collect-max-items`, `--collect-max-scrolls`, `--collect-max-seconds`, idle or end of feed, or a rate-limit or login-wall message. Presets are a data table (`generic`, `x`, `threads`, `bluesky`, `reddit`, `linkedin`, `instagram`, `tiktok`, `mastodon`, `youtube-comments`), and `--collect-item`, `--collect-key` and `--collect-field name=<selector>[@attr]` define or override any of them. `--collect-expand` clicks "show more" buttons with rate limits and action-button guards. Output is a JSON envelope with `items`, `stats` and `stopReason`, or JSONL, to stdout or `--collect-out`. It runs in the normal browse session, so it uses the same profile and cookie jar.

`browse --batch` now keeps semicolons that sit inside JavaScript quotes or brackets in an `eval` step, so `eval (() => { a(); return b })()` no longer needs escaping. Other verbs still split on every `;`, and `\;` is still a literal semicolon.
