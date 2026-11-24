---
"harnery": minor
---

`devtools` now reports each account's available limit resets (`resets[]`: kind, label, count left, expiry), read in the same Claude Code usage call and from Codex's reset-credit endpoint after a successful usage read, with the usage response's count as a fallback. Live reads are recorded to a local usage history (`~/.cache/harnery/devtools/history.jsonl`, pruned after 35 days), and each quota window, plus Cursor's percentages, gains a `recent` burn rate with up to 24 trend points. `enrichFromApi` takes `history: false` to skip the history. `devtools doctor` also probes the Codex reset-credit endpoint, and the table output lists resets and recent rates.
