---
"harnery": minor
---

Add `filesystemPolicyProjection` as its own harness capability dimension, with a live probe that proves enforcement rather than flag acceptance.

Sandbox projection was previously conflated with `policyMapping`, which is about ALLOW/DENY/ASK translation and is a different fact. Folding both into one claim would have made `supported` ambiguous, so projection now has its own dimension and `policyMapping` keeps its meaning.

`harn harness attest --projection` attests the new dimension. A declared-but-unenforced sandbox is indistinguishable from an enforced one at the CLI boundary, so the probe gives a child a file to write and checks the filesystem. It runs a control turn under a permissive mode first: without it, a child that ignored the instruction would read as a working sandbox. An inconclusive control records nothing. The flag is opt-in because it costs two extra turns per capable harness.

Offline, `harn harness bench` checks only whether the adapter renders the projection, and labels that with an `adapter` basis rather than an `attested` one.
