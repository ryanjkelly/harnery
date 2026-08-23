---
"harnery": patch
---

Adopt a mid-generation re-attestation into the joined V3 coordination and
command producer states instead of refusing forever. The producer state path
is derived from the generation alone, so after a `session.attestation_changed`
the stored attestation id could never be superseded and every later authority
transition (for example `agents set-task`) was refused for the rest of the
generation. The producer now adopts the hook's live attestation id in place,
preserving its sequence, clock, and observation dedupe, the same continuation
the hook producer itself performs.
