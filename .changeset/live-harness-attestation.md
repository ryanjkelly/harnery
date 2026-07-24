---
"harnery": minor
---

Add live harness attestation: record what an installed vendor CLI actually does.

`harn harness attest --yes` runs one bounded turn per harness through the
adapter's production spawner and records the result under
`.harnery/harnesses/attestations/`. `harn harness attestations` lists the
records without making a model call. `--yes` is required because the probe
spends real vendor tokens.

`harn harness bench` now reads those records. A current attestation supplies the
observed value for the dimensions it covers and marks them `attested`, so a live
observation that disagrees with the declaration becomes drift. Records are
invalidated automatically by a vendor version change, a declaration edit, or a
failed integrity digest, and stale records fall back to `adapter` basis.

Workflow proof gains an optional `attestation` citation on each
`HarnessEvidenceCoverage` entry. A missing attestation is not a new proof
unknown, so an unattested host keeps its existing gate behavior.

New exports from `harnery/core/harnesses`: `runHarnessAttestation`,
`harnessProofInputs`, `probeBinaryVersion`, and the attestation store surface.
