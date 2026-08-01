---
"harnery": minor
---

Tell agents that the orchestration commands exist.

The block harnery splices into `AGENTS.md` is the only thing every agent in a consuming project is guaranteed to read. It described identity, peers, intent, the scratch journal, artifacts, the decision docket, and councils. It never mentioned `workflow`, `work`, or `supervisor`.

The effect was not subtle. Ask an agent in a harnery project to put a team together and build something, and it reaches for whatever multi-agent primitive its own harness happens to hand it, because as far as its onboarding is concerned harnery does not have one. The three commands that exist for exactly that job stayed invisible, and no amount of README or docs-site coverage reaches an agent that never reads them.

The block now carries a short section naming all three and, more usefully, saying when each applies: `workflow run` for one bounded pass, `work` when the objective has to outlive the attempt, `supervisor` when a human would otherwise babysit the loop. It also points at `workflow approvals list`, because a run that parks for authorization looks identical to a stuck one until you know to check.

Placement is deliberate. The section sits second, directly after identity and peers, rather than at the end of the list. Being last is close enough to absent for something a reader is skimming, and absence is the defect being fixed.

The opening line changes with it: the block previously framed itself entirely as staying out of other agents' way, which is an accurate description of a coordination layer and an incomplete description of this one.
