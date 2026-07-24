---
"harnery": patch
---

Correct the recorded vendor contracts for the `claude-code` and `cursor`
profiles from live attestations.

`claude-code` recorded the placeholder string `"current CLI contract"`, which is
not a version, so its `contract` bench row could only ever report `unknown`. It
now records the version its declaration was actually validated against.
`cursor` recorded a version several releases behind the one it was validated on.

Both values are now written from an attestation rather than by hand. `codex` is
deliberately left alone: it cannot currently be attested on the maintainer's
host, so its `contract` row keeps reporting drift, which is the honest state.
