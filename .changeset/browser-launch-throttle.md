---
"harnery": patch
---

Fix flaky Chromium launches under heavy concurrency.

When many `Browser` instances opened at once — a full test suite, a fan-out of `browse` calls — the simultaneous `child_process.spawn`s exhausted the OS's stdio-pipe resources and Chromium launch died with an unhandled `ENOENT` that a per-call try/catch couldn't catch (it surfaced "between tests", not through the launch promise). `Browser.open()` now bounds concurrent launches with a module-level semaphore (default 3, override via `HARNERY_MAX_BROWSER_LAUNCHES`), gating only the brief spawn phase so N browsers still run concurrently, and retries the whole open sequence up to three times with teardown between attempts for genuinely transient connect failures. A 3×-back-to-back full-suite stress run that previously flaked now passes clean.
