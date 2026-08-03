---
"harnery": patch
---

Harden the pid start token against three ways it could name the wrong process.

The token that tells a pid-map row apart from a recycled pid had gaps on the paths that are hardest to notice, because each one produces a *false* mismatch: a live row gets pruned, and the identity walk lands on the same wrong answer the token was added to prevent.

The `ps` probe read a date formatted through the caller's timezone and locale, so a hook running under `LC_ALL=C` and a shell running under the user's settings described one live process two different ways. Both are now pinned, and a regression test checks it through subprocesses launched under different timezones, since assigning `process.env.TZ` never reaches a child and a test written that way passes either way.

The Linux token counted ticks from boot, and pid-map rows live in the working tree and outlive reboots, so a stale row could match a fresh process that landed on the same pid at the same moment of a later boot. The count is now scoped to the boot it came from. Rows written before this recorded ticks alone and are still compared on what they recorded, so upgrading does not prune a working machine's live rows.

The two probes could also mix: a procfs read that failed fell through to `ps` and answered in the other dialect. The probe is now chosen once per machine and never fallen back from.

The `ps` path is the same code wherever `ps` exists, so `HARNERY_PID_PROBE` forces it and the tests exercise the whole pid-map lifecycle through it rather than leaving that branch to be discovered on somebody's laptop. A parity test holds `coord-client`'s inlined copy of the probe against the canonical one, so the two cannot drift apart in silence.

One upgrade note for machines without procfs: rows already holding a `ps` token written in the local timezone read as mismatches once, since a shifted date cannot be told from a different one without parsing it. Those rows are pruned and rewritten on the next hook, costing one invocation that resolves identity through the session environment instead of the pid walk. Every failure path in the probe still ends in "unverifiable", which trusts a live pid exactly as it did before tokens existed, so no platform ends up worse off than it started.
