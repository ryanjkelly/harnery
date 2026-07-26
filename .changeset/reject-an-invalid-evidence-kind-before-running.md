---
"harnery": minor
---

Reject an unusable evidence kind before a workflow spends anything

`evidence()` is near the end of a workflow by construction, so a kind outside the accepted
vocabulary threw at the finish line. A measured run lost roughly fifty minutes and three
completed agents to `kind: "design"`: the work item went to blocked, the attempt was
charged, and nothing in the proof could recover the result.

The engine now reads the script before either import path and refuses any literal `kind` it
will not accept, naming the offending value and its line. Comments, quoted code, and a
`kind` property that is not an `evidence()` argument are all ignored, and a kind computed at
runtime is left to the existing validation rather than guessed at.
