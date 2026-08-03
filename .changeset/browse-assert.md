---
"harnery": minor
---

Add `browse --assert`: assert page values without a human reading the page.

The layout and content checks answer "does the page look right"; `--assert` answers "does it SAY the right thing" — the heading text, a price, how many cards rendered, whether an error banner is absent. It lets an agent confirm the values it expects and gate on them, instead of a person reading the page back.

One repeatable flag with a small grammar, `<op> <selector> => <expected>`:

- `text` — first match's trimmed text equals the expected string
- `contains` — first match's text includes the expected substring
- `matches` — first match's text matches the expected regex
- `count` — number of matches vs a number or a `>=` / `<=` / `>` / `<` comparator
- `exists` / `absent` — at least one / zero matches (no `=> expected`)

For example `--assert 'text h1 => Welcome'`, `--assert 'count .card => >=3'`, `--assert 'absent .error'`. Results land under `asserts` in the JSON envelope (each carries the observed `actual`); `--assert-fail` exits 2 on any failure. A malformed spec (bad regex, bad count expression, invalid selector) reports an `error` and fails rather than throwing.

This is the portable half of a value-assertion capability — an embedding host can layer domain assertions (funnel cart totals, warehouse reconciliation) on top of the same primitive. New exports: `parseAssertSpec`, `buildAssertCheck`, the `AssertOp` / `AssertSpec` / `AssertResult` types, and `Browser.checkAsserts()`.
