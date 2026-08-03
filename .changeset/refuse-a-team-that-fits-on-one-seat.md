---
"harnery": minor
---

Refuse to freeze a specialist team that would run entirely on one subscription seat.

Harnery does not auto-spread, and it never claimed to: a specialist with no `adapter` inherits the run's default. What was missing is that omitting the pin is silent. A team where nobody pins one reads as a multi-adapter team and behaves as a single-adapter team, and under `subscriptionOnly` that difference is a cliff rather than a curve — the concentration lands on one seat's session meter, so the seat hits its limit and every specialist stops at once instead of the team degrading.

`governor create` now refuses that shape and says which adapters are sitting idle. The check is deliberately narrow, because a false refusal is worse than the miss it prevents: it needs more than one specialist, all of them resolving to a single adapter, subscription auth in force, and another adapter that is **attested reachable**.

That last condition is the one that matters. Counting registered adapters would recommend spreading onto a seat that cannot start, which trades a loud failure for a quiet one — every child handed to it fails closed. Only `harn adapter attest` records that an adapter completed a real turn on this machine, so only an attestation is grounds for the advice.

It fires at `create` because the intent freezes there with no amend path; discovering it at run time means recreating the goal. `--allow-single-adapter` says one seat is what you want.
