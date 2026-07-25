---
"harnery": patch
---

Correct the recorded vendor contracts for the `claude-code` and `cursor`
profiles from live attestations.

`claude-code` recorded the placeholder string `"current CLI contract"`, which is
not a version, so its `contract` bench row could only ever report `unknown`. It
now records the version its declaration was actually validated against.
`cursor` recorded a version several releases behind the one it was validated on.

`codex` recorded a prerelease it was not running either, and is corrected to
`codex-cli 0.144.5`.

All three are now written from an attestation rather than by hand, and all three
`contract` rows reconcile.
